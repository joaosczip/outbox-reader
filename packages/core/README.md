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
3. `OutboxProcessor.processInserts()` fetches the record from DB (must be `PENDING` or `FAILED`), calls `publisher.publish()`, then marks it `PROCESSED`.
4. On failure, marks the record `FAILED` and increments the attempt counter.

### Record lifecycle

```
PENDING → PROCESSED   (publish succeeded)
PENDING → FAILED      (publish failed after retries)
FAILED  → PENDING     (reprocess cronjob re-inserts, re-triggering WAL)
```

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string (logical replication must be enabled) |
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
  -e DATABASE_URL="postgres://user:pass@host:5432/mydb?replication=database" \
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
| `DATABASE_URL` | `postgres://root:root@ecomm-be-pg:5432/ecomm-be?replication=database` |
| `REPLICATION_SLOT_NAME` | `outbox_slot` |
| `TARGET_NATS_URL` | `nats://ecomm-be-nats:4222` |
| `PORT` | `4599` |
| `LOG_LEVEL` | `info` |

## Cronjobs

```bash
# Re-insert FAILED records as PENDING to trigger reprocessing
bun run reprocess-failed-events

# Alert on PENDING records older than the configured window
bun run check-pending-events
```

## Health check

`GET /health` → `{ "status": "ok" }` on port `PORT` (default `4599`).

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
| `startHealthServer` | `src/health.ts` | Minimal HTTP health endpoint |

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
