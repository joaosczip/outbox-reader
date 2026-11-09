# CLAUDE.md — packages/core

Package: `@outbox-reader/core` (private, not published to npm)

This is the **runtime service** for the Transactional Outbox Pattern. It listens to PostgreSQL WAL events via logical replication and publishes them to NATS JetStream.

## Commands

```bash
# Run tests
bun test

# Run a single test file
bun test test/outbox-processor.test.ts

# Start with hot reload
bun run start

# Build
bun run build

# Lint
bun run lint

# Cronjobs
bun run reprocess-failed-events
bun run check-pending-events
bun run purge-processed-events
```

## Source Structure

```
src/
├── app.ts                        — entry point: wires replication, processor, publisher, retry queue
├── config.ts                     — env-based configuration (DATABASE_URL, NATS, retry settings)
├── replication.ts                — thin wrapper around pg-logical-replication (Wal2Json plugin)
├── outbox-processor.ts           — central orchestrator: filters WAL changes, processes inserts
├── outbox-repository.ts          — all DB interactions via pg.Pool with exponential backoff
├── nats-publisher.ts             — lazy-connect NATS publisher; implements Publisher interface
├── publisher-factory.ts          — instantiates publishers from the publisher config (only `nats` is implemented)
├── publisher-config.ts           — publisher config: publisher.yaml + NATS_* env overrides (env-only mode when the file is missing)
├── retry-queue.ts                — in-memory retry queue with backoff for non-blocking record retries
├── successor-drain.ts            — after a head is published or DEAD, publishes ready successors of that aggregate
├── wal-change-handler.ts         — createWalChangeHandler(): WAL onChange (prefetch, per-aggregate ordering, retry enqueue)
├── health.ts                     — /live, /ready (+ /health alias) with pluggable readiness checks (setReadinessCheck)
├── logger.ts                     — pino logger
├── lib.ts                        — public API exports for programmatic use
├── models/
│   └── outbox-record.ts          — OutboxRecord model and status enum
├── types/
│   ├── publisher.ts              — Publisher interface
│   ├── retry-config.ts           — RetryConfig type
│   ├── nats-config.ts            — NATSConfig type
│   └── index.ts
├── db/
│   ├── pool.ts                   — pg.Pool factory
│   └── index.ts
├── utils/
│   ├── aggregate-sequencer.ts    — per-aggregate promise chain shared by WAL handling and RetryQueue (do not re-enter it)
│   ├── column-naming.ts          — snake_case ↔ camelCase column mapping utilities
│   └── run-ordered-by-key.ts     — sequential per key, parallel across keys
└── cronjobs/
    ├── reprocess-failed-events.ts — re-inserts FAILED records as PENDING (or marks them DEAD at max attempts), one transaction per batch with set-based statements (requeueFailed / markManyAsDead)
    ├── check-pending-events.ts    — stale PENDING sweeper: republishes PENDING records older than PENDING_EVENTS_THRESHOLD_MINUTES via OutboxProcessor, sequential per aggregate and parallel across aggregates (concurrency = DB_POOL_SIZE) (at-least-once; consumers must be idempotent)
    └── purge-processed-events.ts  — retention: deletes PROCESSED records older than PROCESSED_RETENTION_DAYS (and DEAD older than DEAD_RETENTION_DAYS, opt-in) in bounded batches. The PROCESSED delete uses the partial index `(processed_at) WHERE status = 'PROCESSED'`; the DEAD delete uses `(created_at) WHERE status = 'DEAD'`.
```

## Key Classes

- **`OutboxProcessor`** (`src/outbox-processor.ts`): Filters WAL changes to outbox inserts, fetches from DB, publishes, and marks as PROCESSED/DEAD. `processInserts()` returns `published | already_processed | dead | blocked | lock_miss`. `filterChanges()` and `processInserts()` are separate for independent testing.
- **`OutboxRepository`** (`src/outbox-repository.ts`): DB layer. Uses `backOff` for `markAsProcessed`/`markAsFailed`/`markAsDead` (optimistic lock on `attempts`; return `false` on a miss). Set-based cron writes: `requeueFailed(ids)` (keeps the original `created_at`, sets `requeued_at = NOW()`) and `markManyAsDead(records)` (return the ids actually changed; missing ids are lock misses). `hasOlderPendingOrFailed` / `findNextReadyPending` implement the per-aggregate gate. Exposes `onTransaction()` for transactional cronjob operations.
- **`NATSPublisher`** (`src/nats-publisher.ts`): Lazy-connects to NATS on first publish. Publishes to `<subjectPrefix>.<record.eventType>` with `record.id` as dedup `msgID` (`Nats-Msg-Id`; unique per event; a `duplicate` PubAck is logged as a warning) and headers `Outbox-Id`, `Outbox-Aggregate-Id`, `Outbox-Aggregate-Type`, `Outbox-Event-Type`, `Outbox-Created-At` (ISO-8601). Subject, body and headers are the public message contract (root `README.md#message-contract`); changing them is breaking.
- **`RetryQueue`** (`src/retry-queue.ts`): In-memory non-blocking retry queue. WAL stream is never blocked by individual record failures.

## Publisher Configuration

`loadPublisherConfig` reads `PUBLISHER_CONFIG_PATH` (default `./publisher.yaml`). These env vars override the YAML `options`: `NATS_SERVERS` (comma-separated; `TARGET_NATS_URL` is a deprecated alias), `NATS_SUBJECT_PREFIX`, `NATS_USER`, `NATS_PASSWORD`, `NATS_TOKEN`, `NATS_CONNECTION_NAME`. If the file is missing and `NATS_SERVERS` + `NATS_SUBJECT_PREFIX` are set, env-only mode is used; the Docker image does not ship a `publisher.yaml`. `sqs`/`kafka` providers fail fast as not implemented. A JetStream stream covering `<subjectPrefix>.>` must exist before startup.

When behavior visible to users changes (env vars, headers, startup errors, cronjobs), update the root `README.md`, `packages/core/README.md` and `AGENTS.md` (integration guide for agents).

## Data Flow

```
PostgreSQL WAL → replication.ts → OutboxProcessor → NATSPublisher → NATS JetStream
                                        ↕
                                 OutboxRepository (pg Pool)
                                        ↕
                                   RetryQueue (in-memory)
```

## Outbox Record Statuses

`PENDING` → `PROCESSED` (success) | `FAILED` (after publish error) → `DEAD` (terminal, `attempts >= MAX_OUTBOX_ATTEMPTS`; never retried or re-inserted by the reprocess cron). Optimistic-lock misses on status writes are logged as warnings and counted (`outbox.records.optimistic_lock_miss`).

## Aggregate order

Inside one process, events of one `aggregateId` are published in `(created_at, id)` ascending order. A later event is not published while an older sibling is `PENDING` or `FAILED`. `PROCESSED` does not block. `DEAD` is terminal and does not block: after the head is marked `DEAD`, the tail may be published. `FAILED` blocks the tail until that head is requeued and published, or becomes `DEAD`. Different aggregates stay parallel (`runOrderedByKey`, concurrency = `DB_POOL_SIZE`).

`AggregateSequencer` is the per-aggregate promise chain shared by the WAL handler and `RetryQueue`, so those two paths do not publish the same aggregate concurrently. Do not call it again from inside a running task for that aggregate (it throws); drain successors in the same turn. A publish throw enqueues only that head. Later siblings stay `PENDING` and are released by the drain when the head is published or marked `DEAD`. The handler still resolves so the LSN can be acked. A batch-level prefetch failure still rejects.

`created_at` is the immutable order key. `requeueFailed` writes the original `created_at` back and sets `requeued_at = NOW()`. `requeued_at` is staleness only: `findStalePendingEvents` keeps `status = 'PENDING' AND created_at < cutoff AND (requeued_at IS NULL OR requeued_at < cutoff)` so the partial `(created_at) WHERE status = 'PENDING'` index still applies. A recently requeued row is not stale. Do not replace that predicate with `COALESCE(requeued_at, created_at)`. `requeued_at` is not the retention age.

The predecessor check is two `UNION ALL` branches (`status = 'PENDING'` and `status = 'FAILED'`), each with `aggregate_id = $1` and `("created_at", "id") < ($2::timestamp, $3::uuid)`, `LIMIT 1`. It does not use `status = ANY(...)` or `status IN (...)`, so each branch can use its partial aggregate-order index. The check runs immediately before publish.

Cross-process races are not covered. The live service and `check-pending-events` do not share a lock: both can pass the predicate (TOCTOU) and publish. That is the existing at-least-once behavior; NATS dedups by `record.id` only inside the stream duplicate window.

## Test Structure

Tests live in `test/`. Mocks are in `test/mocks/`.

- Unit tests cover processor, repository, retry queue, and publisher in isolation.
- Integration/e2e tests use Testcontainers (PostgreSQL + NATS).
