# @outbox-reader/core

The runtime service of [Outbox Reader](../../README.md): it streams outbox `INSERT`s from the PostgreSQL WAL (logical replication, `wal2json`) and publishes them to NATS JetStream.

This package is **not published to npm**. Run it from Docker (`packages/core/Dockerfile`) or from source with Bun >= 1.2.

For end-to-end setup (PostgreSQL prerequisites, replication slot, outbox table, JetStream stream, client), follow the **[Quick Start in the root README](../../README.md#quick-start)**. The message format consumers receive is described in the [message contract](../../README.md#message-contract).

## How it works

```
PostgreSQL WAL → replication.ts → OutboxProcessor → NATSPublisher → NATS JetStream
                                         ↕
                                  OutboxRepository (pg Pool)
                                         ↕
                                  RetryQueue (in-memory)
```

1. `startReplication()` subscribes to the replication slot (`REPLICATION_SLOT_NAME`). With `wal2json` >= 2.0 the server streams only `INSERT`s on the outbox table (`TABLE_NAME`).
2. `OutboxProcessor.filterChanges()` maps the WAL rows to outbox records (honouring `COLUMN_NAMING`).
3. The records are re-read from the database in one query (only `PENDING`/`FAILED` ones are processed). If an older sibling of the same aggregate is still `PENDING` or `FAILED`, the record is `blocked` and not published yet; otherwise it is published and marked `PROCESSED`.
4. A failed publish hands the head to the in-memory `RetryQueue`; later siblings of that aggregate stay `PENDING` until the head is published or marked `DEAD`. At `MAX_OUTBOX_ATTEMPTS` the record becomes `DEAD`.

### Aggregate order

Within one process, events of the same `aggregateId` are published in `(created_at, id)` order. A later event is not published while an older sibling is `PENDING` or `FAILED`. `PROCESSED` siblings do not block. `DEAD` is terminal and does not block: after the head is marked `DEAD`, the tail may be published. `FAILED` blocks the tail until that head is requeued and published, or becomes `DEAD`. Different aggregates stay parallel (up to `DB_POOL_SIZE`).

WAL handling and the in-memory `RetryQueue` share a per-aggregate promise chain, so one process does not publish the same aggregate from both paths at once. The chain must not be re-entered from inside a running turn; successors are drained in that same turn.

This is not a cross-process lock. The predecessor check runs in the database immediately before publish. The live service and the `check-pending-events` sweeper can both pass that check (a time-of-check/time-of-use race) and both publish. Delivery stays at-least-once: NATS dedups by `record.id` only inside the stream's duplicate window (default 2 minutes). Consumers must be idempotent.

`created_at` is the immutable order key. Requeue copies the original `created_at` and sets `requeued_at = NOW()`. `requeued_at` is used only to decide staleness (a recently requeued row is not stale). It is not the order key and it is not the retention age.

### Failure behaviour

A WAL position is acknowledged only after its events were published or handed to the retry queue. Because PostgreSQL acknowledgements are cumulative, any replication or batch error makes the service shut down gracefully and exit with code `1`, so the restarted process resumes from the last confirmed position. Startup failures (missing slot, invalid publisher config, NATS connect, replication subscribe) also exit `1`; a missing slot is reported with a hint to run `outy setup replication`.

### Record lifecycle

```
PENDING → PROCESSED   (publish succeeded)
PENDING → FAILED      (publish failed after retries)
FAILED  → PENDING     (reprocess cronjob re-inserts, re-triggering WAL)
PENDING/FAILED → DEAD (terminal: attempts reached MAX_OUTBOX_ATTEMPTS; never retried)
```

## Configuration

The full list of environment variables (database, NATS, cronjobs, telemetry) is in the [root configuration reference](../../README.md#configuration-reference) and [`.env.example`](../../.env.example). The ones you always need:

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | Plain PostgreSQL URL. Do **not** add `?replication=database`; the service adds it to the replication connection itself. |
| `REPLICATION_SLOT_NAME` | Yes (service only) | — | Slot created with `outy setup replication`. |
| `NATS_SERVERS` | Yes, unless set in `publisher.yaml` | — | Comma-separated NATS URLs (`TARGET_NATS_URL` is a deprecated alias). |
| `NATS_SUBJECT_PREFIX` | Yes, unless set in `publisher.yaml` | — | Messages go to `<prefix>.<eventType>`. |
| `TABLE_NAME` / `COLUMN_NAMING` | No | `outbox` / `snake_case` | Must match the table created by the CLI and the client adapter options. |
| `PORT` | No | `4599` | Health server port. |

### Publisher config

NATS settings come from environment variables, from a YAML file at `PUBLISHER_CONFIG_PATH` (default `./publisher.yaml`), or both:

- `NATS_SERVERS`, `NATS_SUBJECT_PREFIX`, `NATS_USER`, `NATS_PASSWORD`, `NATS_TOKEN` and `NATS_CONNECTION_NAME` override the matching `options` in the YAML.
- If the YAML file does not exist and `NATS_SERVERS` + `NATS_SUBJECT_PREFIX` are set, the service runs in env-only mode with default retry settings.
- Use the YAML (see [`publisher.example.yaml`](../../publisher.example.yaml)) to tune `retryConfig` and reconnect options. Only `provider: nats` is implemented; `sqs` and `kafka` fail at startup as not implemented.

A JetStream stream whose subjects match `<prefix>.>` must exist before the service starts.

## Running

### From source

```bash
# from the repo root
bun install
cp .env.example .env    # then edit it
bun --env-file=.env packages/core/src/app.ts

# or, with hot reload during development
bun run start
```

### Docker

The image contains the service and the cronjobs. It does **not** include a `publisher.yaml`: configure NATS with environment variables, or mount a file.

```bash
# build from the repo root (the context must include the workspace)
docker build -f packages/core/Dockerfile -t outbox-reader .

docker run -d --name outbox-reader \
  -e DATABASE_URL="postgres://user:pass@db-host:5432/mydb" \
  -e REPLICATION_SLOT_NAME=outbox_slot \
  -e NATS_SERVERS=nats://nats-host:4222 \
  -e NATS_SUBJECT_PREFIX=events \
  -p 4599:4599 -p 9464:9464 \
  outbox-reader

# or with an env file and an optional publisher.yaml (the working directory is /app)
docker run -d --env-file .env -v "$PWD/publisher.yaml:/app/publisher.yaml:ro" -p 4599:4599 outbox-reader
```

Run one instance per replication slot. For the full local stack (PostgreSQL + wal2json, NATS, Prometheus) see [Try it locally with Docker Compose](../../README.md#try-it-locally-with-docker-compose).

## Cronjobs

| Script | Purpose |
|---|---|
| `src/cronjobs/check-pending-events.ts` | Stale `PENDING` sweeper: republishes records older than `PENDING_EVENTS_THRESHOLD_MINUTES` (default 10) through `OutboxProcessor`, sequential per aggregate. Each record is re-read first, so one processed in the meantime is skipped; a failing one is marked `FAILED` and its later siblings stay `PENDING` until it is published or `DEAD`. A recently requeued row (fresh `requeued_at`) is not stale. Needs the NATS settings. |
| `src/cronjobs/reprocess-failed-events.ts` | In batches, re-inserts `FAILED` records as `PENDING` (new WAL `INSERT`) in one transaction per batch; records at `MAX_OUTBOX_ATTEMPTS` are marked `DEAD`. |
| `src/cronjobs/purge-processed-events.ts` | Deletes `PROCESSED` records older than `PROCESSED_RETENTION_DAYS` (default 7) in batches of 1000; `DEAD` records only when `DEAD_RETENTION_DAYS` is set. Never deletes `PENDING`/`FAILED`. |

```bash
# from a source checkout
bun run check-pending-events
bun run reprocess-failed-events
bun run purge-processed-events

# from the image
docker run --rm --env-file .env outbox-reader bun packages/core/src/cronjobs/check-pending-events.ts
```

Cronjobs need `DATABASE_URL` but not `REPLICATION_SLOT_NAME`, and exit `1` on a fatal error. Recommended schedules and a Kubernetes `CronJob` example are in the [root README](../../README.md#cronjobs).

> **At-least-once delivery.** NATS deduplicates by record id only within the stream's duplicate window (default 2 minutes). If a publish succeeded but marking the record `PROCESSED` failed, the sweeper republishes it later and consumers receive a duplicate. Consumers must be idempotent (deduplicate on the `Outbox-Id` header).

## Health check

Served on `PORT` (default `4599`):

- `GET /live` → always `200 {"status":"ok"}` (liveness probe).
- `GET /ready` → runs the readiness checks (`replication`, `publisher`, `database`) concurrently, each bounded by `checkTimeoutMs` (default `2000`). Returns `200 {"status":"ok","checks":{...}}` when all pass, `503 {"status":"fail","checks":{...}}` otherwise.
- `GET /health` → alias of `/ready`.

Prometheus metrics are served on `PROMETHEUS_PORT` (default `9464`) at `/metrics`.

## Programmatic use

`src/lib.ts` exports the building blocks for custom runtimes. The package is private, so consume it from the workspace (or a git checkout), not from npm.

```ts
import {
  // service building blocks
  OutboxProcessor,
  OutboxRepository,
  NATSPublisher,
  RetryQueue,
  startReplication,
  createWalChangeHandler,
  startHealthServer,
  Logger,
  // configuration
  config,
  loadAppConfig,
  loadCronConfig,
  dbWriteRetryConfig,
  // publisher config and factory
  loadPublisherConfig,
  createPublisher,
} from "@outbox-reader/core";
```

Types (`OutboxRecord`, `OutboxStatus`, `Publisher`, `RetryConfig`, `PublisherConfig`, ...) are exported as well.

Health server example:

```ts
const server = startHealthServer({ port: 4599, checkTimeoutMs: 2000, readinessChecks: { db: () => true } });
server.setReadinessCheck("nats", async () => publisher.isConnected());
server.removeReadinessCheck("db");
server.stop(true);
```

## Key classes

| Class / function | File | Responsibility |
|---|---|---|
| `OutboxProcessor` | `src/outbox-processor.ts` | Filters WAL changes and processes inserts |
| `OutboxRepository` | `src/outbox-repository.ts` | All database access, with exponential backoff and optimistic locking on `attempts` |
| `NATSPublisher` | `src/nats-publisher.ts` | Lazy-connecting JetStream publisher (subject, `Nats-Msg-Id` and `Outbox-*` headers) |
| `RetryQueue` | `src/retry-queue.ts` | In-memory, non-blocking retries of failed records |
| `createWalChangeHandler` | `src/wal-change-handler.ts` | WAL `onChange`: batched prefetch, per-aggregate ordering, retry enqueue |
| `startReplication` | `src/replication.ts` | Wrapper around `LogicalReplicationService` with manual LSN acknowledgement |
| `startHealthServer` | `src/health.ts` | `/live`, `/ready`, `/health` endpoints |

## Testing

```bash
bun test
bun test test/outbox-processor.test.ts   # a single file
```

Integration tests use Testcontainers (PostgreSQL + NATS) and need Docker.

## License

[MIT](../../LICENSE)
