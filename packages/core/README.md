# @outbox-reader/core

Runtime service for the [Transactional Outbox Pattern](https://microservices.io/patterns/data/transactional-outbox.html). Listens to PostgreSQL WAL events via logical replication and publishes them to NATS JetStream.

## How it works

```
PostgreSQL WAL → replication.ts → OutboxProcessor → NATSPublisher → NATS JetStream
                                         ↕
                                  OutboxRepository (pg Pool)
```

1. `startReplication()` subscribes to a PostgreSQL logical replication slot using the Wal2Json plugin.
2. On each WAL event, `OutboxProcessor.filterChanges()` filters for `INSERT` operations on the `outbox` table.
3. `OutboxProcessor.processInserts()` fetches the record from DB (must be `PENDING` or `FAILED`). If an older sibling of the same aggregate is still `PENDING` or `FAILED`, it returns `blocked` and does not publish. Otherwise it calls `publisher.publish()` and marks the record `PROCESSED`.
4. On a publish failure the head is retried in memory. Later siblings of that aggregate stay `PENDING` until the head is published or marked `DEAD`.

### Aggregate order

Within one process, events of the same `aggregateId` are published in `(created_at, id)` order. A later event is not published while an older sibling is `PENDING` or `FAILED`. `PROCESSED` siblings do not block. `DEAD` is terminal and does not block: after the head is marked `DEAD`, the tail may be published. `FAILED` blocks the tail until that head is requeued and published, or becomes `DEAD`. Different aggregates stay parallel (up to `DB_POOL_SIZE`).

WAL handling and the in-memory `RetryQueue` share a per-aggregate promise chain, so one process does not publish the same aggregate from both paths at once. The chain must not be re-entered from inside a running turn; successors are drained in that same turn.

This is not a cross-process lock. The predecessor check runs in the database immediately before publish. The live service and the `check-pending-events` sweeper can both pass that check (a time-of-check/time-of-use race) and both publish. Delivery stays at-least-once: NATS dedups by `record.id` only inside the stream's duplicate window (default 2 minutes). Consumers must be idempotent.

`created_at` is the immutable order key. Requeue copies the original `created_at` and sets `requeued_at = NOW()`. `requeued_at` is used only to decide staleness (a recently requeued row is not stale). It is not the order key and it is not the retention age.

### Health and failure behaviour

- `GET /live` — 200 while the process is up.
- `GET /ready` (alias `/health`) — 200 only when every readiness check passes (`replication` subscribed and error-free, `publisher` connected, `database` answers `SELECT 1`); 503 otherwise.
- A WAL LSN is acknowledged only after its events were published (or handed to the retry queue). Because PostgreSQL acknowledgements are cumulative, any replication or batch-processing error (e.g. the database being unreachable) makes the service shut down with exit code 1, so the restarted process resumes from the last confirmed LSN. Startup failures (publisher config/connect, replication subscribe) also exit with code 1.

### Record lifecycle

```
PENDING → PROCESSED   (publish succeeded)
PENDING → FAILED      (publish failed after retries)
FAILED  → PENDING     (reprocess cronjob re-inserts, re-triggering WAL)
PENDING/FAILED → DEAD (terminal: attempts reached MAX_OUTBOX_ATTEMPTS; never retried)
```

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string (logical replication must be enabled). Use a plain URL — do **not** add `?replication=database`: the service adds it for the replication connection only, and the same URL also feeds the regular query pool. |
| `REPLICATION_SLOT_NAME` | Yes | — | Name of the PostgreSQL logical replication slot |
| `TARGET_NATS_URL` | No | `nats://localhost:4222` | NATS server URL |
| `PORT` | No | `4599` | Port for the health check HTTP server |

## Running

### Development

```bash
bun run start   # hot reload via --watch
```

### Docker (standalone)

Build and run only the `outbox-reader` service against an already-running Postgres and NATS:

```bash
# Build from the repo root (context must include the workspace root)
docker build -f packages/core/Dockerfile -t outbox-reader .

docker run -d \
  -e DATABASE_URL="postgres://user:pass@host:5432/mydb" \
  -e REPLICATION_SLOT_NAME="my_slot" \
  -e TARGET_NATS_URL="nats://nats-host:4222" \
  -p 4599:4599 \
  outbox-reader
```

Or with an env file:

```bash
docker run -d --env-file .env -p 4599:4599 outbox-reader
```

### Docker Compose (full stack)

The repo's `docker-compose.yml` starts PostgreSQL (with `wal2json`), NATS JetStream, and `outbox-reader` together.

**Prerequisites:**

- `Dockerfile.pg` — custom Postgres image with `wal2json` installed
- `pg.conf` — must include `wal_level = logical`
- `nats.conf` — must enable JetStream

Minimal `pg.conf`:

```
wal_level = logical
max_wal_senders = 10
max_replication_slots = 10
```

Minimal `nats.conf`:

```
jetstream {
  store_dir: /data/jetstream
}
```

Start everything:

```bash
docker compose up -d
```

| Service | Container | Ports |
|---|---|---|
| PostgreSQL | `ecomm-be-pg` | `5433:5432` |
| NATS | `ecomm-be-nats` | `4222`, `8222` |
| outbox-reader | `outbox-reader` | `4599` (health) |

`outbox-reader` depends on both `db` and `nats`, restarts on failure, and is health-checked via `GET /health` on port `4599`.

Default environment in compose (override as needed):

| Variable | Default |
|---|---|
| `DATABASE_URL` | `postgres://root:root@ecomm-be-pg:5432/ecomm-be` |
| `REPLICATION_SLOT_NAME` | `outbox_slot` |
| `TARGET_NATS_URL` | `nats://ecomm-be-nats:4222` |
| `PORT` | `4599` |
| `LOG_LEVEL` | `info` |

## Cronjobs

```bash
# Re-insert FAILED records as PENDING to trigger reprocessing (records at MAX_OUTBOX_ATTEMPTS are marked DEAD instead)
bun run reprocess-failed-events

# Sweep stale PENDING records (older than PENDING_EVENTS_THRESHOLD_MINUTES, default 10)
bun run check-pending-events
```

`check-pending-events` is a **stale PENDING sweeper**. It finds `PENDING` records older than the threshold (events the
service most likely lost: a crash, a lost in-memory retry, a WAL event acknowledged but never processed), in batches of
100, and sends each one through the regular `OutboxProcessor` flow using the publisher configured in `publisher.yaml`
(`PUBLISHER_CONFIG_PATH`). Each record is re-read from the DB first, so one processed in the meantime is skipped. A record
that fails is marked `FAILED` (so `reprocess-failed-events` picks it up) and does not stop other aggregates. Later events of the failed aggregate stay `PENDING` until that head is published or marked `DEAD`. A row is stale only when `created_at` is older than the threshold and `requeued_at` is null or also older than the threshold, so a recently requeued row (old `created_at`, fresh `requeued_at`) is left alone. It needs
`DATABASE_URL` but not `REPLICATION_SLOT_NAME`; `MAX_OUTBOX_ATTEMPTS` is respected. Exits with `1` on a fatal error.

> **At-least-once delivery.** NATS dedups by `record.id` only within the stream's duplicate window (default 2 minutes).
> If the original publish actually succeeded but marking the record `PROCESSED` failed, the sweeper republishes it
> outside that window and consumers receive a duplicate. Consumers must be idempotent.

## Health check

Served on port `PORT` (default `4599`):

- `GET /live` → always `200 { "status": "ok" }` (liveness probe).
- `GET /ready` → runs all registered readiness checks concurrently (each bounded by `checkTimeoutMs`, default `2000`). A check that returns `false`, throws or times out is `"fail"`. Returns `200 { "status": "ok", "checks": { "<name>": "ok" } }` when all pass (or none are registered), `503 { "status": "fail", "checks": { ... } }` otherwise.
- `GET /health` → alias of `/ready` (backward compatible).

```ts
const server = startHealthServer({ port: 4599, checkTimeoutMs: 2000, readinessChecks: { db: () => true } });
// register/replace checks later, e.g. once the publisher exists
server.setReadinessCheck("nats", async () => publisher.isConnected());
server.removeReadinessCheck("db");
server.stop(true);
```

`startHealthServer()` and `startHealthServer(port)` remain supported.

## Testing

```bash
bun test
# or a single file:
bun test test/outbox-processor.test.ts
```

## Key classes

| Class / function | File | Responsibility |
|---|---|---|
| `OutboxProcessor` | `src/outbox-processor.ts` | Central orchestrator — filters WAL changes, processes inserts |
| `OutboxRepository` | `src/outbox-repository.ts` | All DB interactions with exponential backoff |
| `NATSPublisher` | `src/nats-publisher.ts` | Lazy-connect NATS publisher with retry |
| `startReplication` | `src/replication.ts` | Thin wrapper around `LogicalReplicationService` |
| `startHealthServer` | `src/health.ts` | HTTP liveness (`/live`) and readiness (`/ready`, `/health`) endpoints |

## Programmatic use

`src/lib.ts` exports all core components and types for use in other packages or custom runtimes:

```ts
import {
  OutboxProcessor,
  OutboxRepository,
  NATSPublisher,
  startReplication,
  config,
  dbWriteRetryConfig,
  natsPublisherRetryConfig,
  natsConnectionConfig,
} from "@outbox-reader/core";
```
