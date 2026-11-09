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
│   └── column-naming.ts          — snake_case ↔ camelCase column mapping utilities
└── cronjobs/
    ├── reprocess-failed-events.ts — re-inserts FAILED records as PENDING (or marks them DEAD at max attempts), one transaction per batch with set-based statements (requeueFailed / markManyAsDead)
    ├── check-pending-events.ts    — stale PENDING sweeper: republishes PENDING records older than PENDING_EVENTS_THRESHOLD_MINUTES via OutboxProcessor, sequential per aggregate and parallel across aggregates (concurrency = DB_POOL_SIZE) (at-least-once; consumers must be idempotent)
    └── purge-processed-events.ts  — retention: deletes PROCESSED records older than PROCESSED_RETENTION_DAYS (and DEAD older than DEAD_RETENTION_DAYS, opt-in) in bounded batches
```

## Key Classes

- **`OutboxProcessor`** (`src/outbox-processor.ts`): Filters WAL changes to outbox inserts, fetches from DB, publishes, and marks as PROCESSED/FAILED. `filterChanges()` and `processInserts()` are separate for independent testing.
- **`OutboxRepository`** (`src/outbox-repository.ts`): DB layer. Uses `backOff` for `markAsProcessed`/`markAsFailed`/`markAsDead` (optimistic lock on `attempts`; return `false` on a miss). Set-based cron writes: `requeueFailed(ids)` and `markManyAsDead(records)` (return the ids actually changed; missing ids are lock misses). Exposes `onTransaction()` for transactional cronjob operations.
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

## Test Structure

Tests live in `test/`. Mocks are in `test/mocks/`.

- Unit tests cover processor, repository, retry queue, and publisher in isolation.
- Integration/e2e tests use Testcontainers (PostgreSQL + NATS).
