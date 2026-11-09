# Outbox Reader

Outbox Reader implements the [Transactional Outbox Pattern](https://microservices.io/patterns/data/transactional-outbox.html) for PostgreSQL and NATS JetStream. Your application writes an event row into an `outbox` table **in the same database transaction** as its domain change. The Outbox Reader service streams new outbox rows from the PostgreSQL write-ahead log (logical replication with `wal2json`), publishes each one to NATS JetStream, and marks it `PROCESSED`. Failed publishes are retried, stale events are swept up by cronjobs, and delivery is at-least-once.

```
your app ──(same transaction)──▶ outbox table
                                     │  INSERT
                                     ▼
PostgreSQL WAL (wal2json) ─▶ outbox-reader ─▶ NATS JetStream ─▶ your consumers
                                     │                       subject: <prefix>.<eventType>
                                     ▼
                    status: PENDING → PROCESSED | FAILED → DEAD
```

> Building this into another project with an AI agent? See [AGENTS.md](AGENTS.md) for a condensed integration checklist.

## Contents

- [Packages](#packages)
- [Quick Start](#quick-start)
- [Try it locally with Docker Compose](#try-it-locally-with-docker-compose)
- [Message contract](#message-contract)
- [Naming must match everywhere](#naming-must-match-everywhere)
- [Configuration reference](#configuration-reference)
- [Operations](#operations)
- [Health endpoints and metrics](#health-endpoints-and-metrics)
- [Troubleshooting](#troubleshooting)
- [PostgreSQL setup in detail](#postgresql-setup-in-detail)
- [Development](#development)

## Packages

| Package | npm name | What it is | How you use it |
|---|---|---|---|
| [`packages/core`](packages/core/README.md) | `@outbox-reader/core` (**not published**) | The runtime service: WAL replication, publishing to NATS, retries, cronjobs | Run it from Docker (build `packages/core/Dockerfile`) or from source with Bun |
| [`packages/cli`](packages/cli/README.md) | [`@joaosczip/outy-cli`](https://www.npmjs.com/package/@joaosczip/outy-cli) | `outy` CLI: creates the replication slot and the outbox table schema/migration | `bunx @joaosczip/outy-cli <command>` (requires [Bun](https://bun.sh)) |
| [`packages/client`](packages/client/README.md) | [`@joaosczip/outy-client`](https://www.npmjs.com/package/@joaosczip/outy-client) | ORM-agnostic library to insert outbox events inside your transaction (Prisma and Sequelize adapters) | `npm install @joaosczip/outy-client` (Node.js >= 18 or Bun) |

The client and the CLI do not depend on core. There is no `@outbox-reader/client` package on npm; use `@joaosczip/outy-client`.

## Quick Start

Each step has a command and the result you should see. Do them in order: later steps depend on earlier ones.

Requirements: PostgreSQL with the `wal2json` plugin (tested with PostgreSQL 17 and wal2json 2.x), NATS Server with JetStream enabled, Docker or Bun >= 1.2 to run the service, and Bun to run the `outy` CLI.

The examples use the default table `outbox` with `snake_case` columns, the slot `outbox_slot`, the subject prefix `events` and the stream `OUTBOX`. If you change any of these, change them everywhere (see [Naming must match everywhere](#naming-must-match-everywhere)).

### 1. Prepare PostgreSQL

PostgreSQL needs `wal_level = logical`, the `wal2json` output plugin, and a user with the `REPLICATION` role. The table generated in step 3 also uses the [`pg_uuidv7`](https://github.com/fboulnois/pg_uuidv7) extension (`uuid_generate_v7()` as the `id` default): install it on the server (it is not part of the official `postgres` image, nor of this repo's `Dockerfile.pg`), or remove the `CREATE EXTENSION` line and the `DEFAULT uuid_generate_v7()` from the generated SQL. The client always sends its own UUIDv7 id, so the default is only a fallback for other producers. These settings need a server restart. See [PostgreSQL setup in detail](#postgresql-setup-in-detail) for Docker, docker-compose and package-manager instructions.

```sql
-- postgresql.conf (then restart): wal_level = logical, max_wal_senders = 10, max_replication_slots = 10
CREATE USER outbox_user WITH LOGIN REPLICATION PASSWORD 'secret';   -- or: ALTER USER existing_user REPLICATION;
```

Verify:

```sh
psql "$DATABASE_URL" -c "SHOW wal_level;"
#  wal_level
# -----------
#  logical

psql "$DATABASE_URL" -c "SELECT rolreplication FROM pg_roles WHERE rolname = current_user;"
#  rolreplication
# ----------------
#  t
```

The user that the service connects with also needs `SELECT`, `INSERT`, `UPDATE` and `DELETE` on the outbox table.

### 2. Create the replication slot

```sh
PGPASSWORD=secret bunx @joaosczip/outy-cli setup replication \
  -h localhost -p 5432 -u outbox_user -d mydb -s outbox_slot
```

Expected output:

```
Replication slot "outbox_slot" created successfully.
```

Running it again prints `Replication slot "outbox_slot" already exists. Nothing to do.` Prefer `PGPASSWORD` over the `-P` flag so the password stays out of your shell history. Verify:

```sh
psql "$DATABASE_URL" -c "SELECT slot_name, plugin FROM pg_replication_slots;"
#   slot_name  |  plugin
# -------------+----------
#  outbox_slot | wal2json
```

A slot keeps WAL on disk until the service confirms it. If you stop using Outbox Reader, drop the slot (`SELECT pg_drop_replication_slot('outbox_slot');`), or the disk will fill up.

### 3. Create the outbox table

The canonical schema is whatever `outy create migration` produces. Do not write the table by hand.

```sh
# Plain SQL: prints the canonical CREATE TABLE (and indexes) to stdout
bunx @joaosczip/outy-cli create migration > outbox.sql
psql "$DATABASE_URL" -f outbox.sql

# Or generate a migration for your ORM
bunx @joaosczip/outy-cli create migration --target prisma
bunx @joaosczip/outy-cli create migration --target sequelize
```

Use `-t <table>` and `--column-naming snake_case|camelCase|PascalCase` to change the table name or column style. See the [CLI README](packages/cli/README.md) for every command and flag (including `outy create schema` for Prisma models).

Verify:

```sh
psql "$DATABASE_URL" -c '\d outbox'
# Table "public.outbox" with columns id, aggregate_id, aggregate_type, event_type, payload, status, attempts, created_at, processed_at, ...
```

### 4. Create the JetStream stream

The service publishes to `<NATS_SUBJECT_PREFIX>.<eventType>`. A stream whose subjects cover `<prefix>.>` **must exist before the service starts**. Without it, publishes fail with "no responders".

```sh
nats stream add OUTBOX --subjects 'events.>' --dupe-window 2m --defaults
```

Verify:

```sh
nats stream info OUTBOX
# Configuration: Subjects: events.> ... Duplicate Window: 2m0s
```

The duplicate window is how long JetStream deduplicates republished events (by outbox id). Keep it at least as long as your retry delays.

### 5. Configure and run the service

The service is not on npm. Build the image from this repository:

```sh
git clone https://github.com/joaosczip/outbox-reader.git && cd outbox-reader
docker build -f packages/core/Dockerfile -t outbox-reader .
```

Run it with environment variables only (no `publisher.yaml` needed):

```sh
docker run -d --name outbox-reader \
  -e DATABASE_URL="postgres://outbox_user:secret@db-host:5432/mydb" \
  -e REPLICATION_SLOT_NAME=outbox_slot \
  -e NATS_SERVERS=nats://nats-host:4222 \
  -e NATS_SUBJECT_PREFIX=events \
  -p 4599:4599 -p 9464:9464 \
  outbox-reader
```

`DATABASE_URL` must be a plain URL. Do **not** add `?replication=database`: the service adds it to the replication connection itself and uses the same URL for regular queries.

From source instead of Docker: `bun install`, `cp .env.example .env`, edit it, then `bun --env-file=.env packages/core/src/app.ts`.

Verify:

```sh
curl -s localhost:4599/ready
# {"status":"ok","checks":{"replication":"ok","publisher":"ok","database":"ok"}}
```

A `503` names the failing check. The [Troubleshooting](#troubleshooting) table maps the common startup errors to fixes. If the slot from step 2 is missing, the service exits with code 1 and tells you to run `outy setup replication`.

Run **exactly one** instance per replication slot. A second instance fails with `replication slot "outbox_slot" is active for PID ...`.

### 6. Write an event from your application

```sh
npm install @joaosczip/outy-client     # or: bun add @joaosczip/outy-client
```

Prisma:

```ts
import { OutboxClient, PrismaAdapter } from "@joaosczip/outy-client";

// tableName / columnNaming default to "outbox" / "snake_case"; they must match steps 3 and 5
const outbox = new OutboxClient(new PrismaAdapter({ tableName: "outbox", columnNaming: "snake_case" }));

await prisma.$transaction(async (tx) => {
  const order = await tx.order.create({ data: { total: 42 } });
  await outbox.create(
    { aggregateId: order.id, aggregateType: "Order", eventType: "order.created", payload: order },
    tx, // the transaction from $transaction: the event commits or rolls back with the order
  );
});
```

Sequelize:

```ts
import { OutboxClient, SequelizeAdapter } from "@joaosczip/outy-client";

const outbox = new OutboxClient(new SequelizeAdapter(sequelize, { tableName: "outbox", columnNaming: "snake_case" }));

await sequelize.transaction(async (t) => {
  const order = await Order.create({ total: 42 }, { transaction: t });
  await outbox.create(
    { aggregateId: order.id, aggregateType: "Order", eventType: "order.created", payload: order.toJSON() },
    t,
  );
});
```

`outbox.create(event, tx)` accepts the raw transaction or `{ underlying: tx }`, and returns the record id. Pass an `id` in the event to choose it yourself. `eventType` becomes part of the NATS subject, so use subject-safe tokens (letters, digits, `-`, `_`, and `.` to separate tokens; no spaces, `*` or `>`). See the [client README](packages/client/README.md) for the full API and how to write your own adapter.

Verify (from the database and from NATS):

```sh
psql "$DATABASE_URL" -c "SELECT id, event_type, status FROM outbox ORDER BY created_at DESC LIMIT 1;"
#  ... | order.created | PROCESSED

nats stream info OUTBOX        # State: Messages: 1
nats stream view OUTBOX        # shows subject events.order.created, Outbox-* headers and the JSON payload
```

### 7. Consume the events

Create a durable consumer, then read messages. This example uses the official NATS JavaScript client (`npm install @nats-io/transport-node @nats-io/jetstream`):

```sh
nats consumer add OUTBOX billing --pull --ack explicit --deliver all --defaults
```

```ts
import { connect } from "@nats-io/transport-node";
import { jetstream } from "@nats-io/jetstream";

const nc = await connect({ servers: "nats://localhost:4222" });
const consumer = await jetstream(nc).consumers.get("OUTBOX", "billing");

for await (const msg of await consumer.consume()) {
  const outboxId = msg.headers?.get("Outbox-Id");           // stable id: use it to deduplicate
  const eventType = msg.headers?.get("Outbox-Event-Type");  // e.g. "order.created"
  const aggregateId = msg.headers?.get("Outbox-Aggregate-Id");
  const payload = msg.json();

  if (await alreadyHandled(outboxId)) { msg.ack(); continue; }   // at-least-once: duplicates happen
  await handle(eventType, aggregateId, payload);
  await markHandled(outboxId);
  msg.ack();
}
```

Verify: the consumer logs the event from step 6, and `nats consumer info OUTBOX billing` shows `Ack Floor` advancing.

Finally, schedule the [cronjobs](#cronjobs). Without them, events whose publish failed or was lost are not retried after the in-memory retries run out.

## Try it locally with Docker Compose

The repository's `docker-compose.yml` runs the whole stack for development:

| Service | Container | Ports | Notes |
|---|---|---|---|
| `db` | `outbox-reader-pg` | `5432` | PostgreSQL 17 + wal2json (`Dockerfile.pg`, `pg.conf`), user/password `root`/`root`, database `outbox` |
| `nats` | `outbox-reader-nats` | `4222`, `8222` (monitoring) | JetStream enabled (`nats.conf`) |
| `nats-init` | `outbox-reader-nats-init` | — | One-shot: creates stream `TEST` (subjects `test.>`, dupe window 2m) and pull consumer `test-consumer` |
| `nats-box` | `outbox-reader-nats-cli` | — | `nats` CLI: `docker compose exec nats-box nats stream info TEST` |
| `outbox-reader` | `outbox-reader` | `4599` (health), `9464` (metrics) | `NATS_SERVERS=nats://nats:4222`, `NATS_SUBJECT_PREFIX=test`, slot `outbox_slot`; starts after `nats-init` completes |
| `prometheus` | `outbox-reader-prometheus` | `9090` | Scrapes `outbox-reader:9464` |

```sh
docker compose up -d db nats nats-init

# slot + table (the service exits until the slot exists; restart: on-failure brings it back)
PGPASSWORD=root bunx @joaosczip/outy-cli setup replication -h localhost -u root -d outbox -s outbox_slot
bunx @joaosczip/outy-cli create migration | docker compose exec -T db psql -U root -d outbox

docker compose up -d --build outbox-reader prometheus
curl -s localhost:4599/ready

# write a test event and look at it in NATS
docker compose exec db psql -U root -d outbox -c \
  "INSERT INTO outbox (id, aggregate_id, aggregate_type, event_type, payload) VALUES ('evt-1', 'order-1', 'Order', 'order.created', '{\"total\":42}');"
docker compose exec nats-box nats stream view TEST
```

The `INSERT` above relies on the column defaults from the generated schema (`status = 'PENDING'`, `attempts = 0`, `created_at = now()`). In application code, use the client instead.

## Message contract

Each outbox record becomes one JetStream message:

| Part | Value |
|---|---|
| Subject | `<subjectPrefix>.<eventType>`, e.g. `events.order.created` |
| Body | The record's `payload`, JSON-encoded |
| `Nats-Msg-Id` | The outbox record id. JetStream drops a repeat of the same id inside the stream's duplicate window (default 2 minutes). |
| `Outbox-Id` | The outbox record id (use it to deduplicate) |
| `Outbox-Aggregate-Id` | `aggregateId` |
| `Outbox-Aggregate-Type` | `aggregateType` |
| `Outbox-Event-Type` | `eventType` |
| `Outbox-Created-At` | Record creation time, ISO-8601 (e.g. `2026-01-31T12:00:00.000Z`) |

Guarantees:

- **At-least-once delivery.** A record can be published more than once, for example when the publish succeeded but marking it `PROCESSED` failed and a cronjob republished it after the duplicate window. Consumers must be idempotent: deduplicate on `Outbox-Id`.
- **Ordering per aggregate.** Events of the same `aggregateId` are published sequentially in commit order. Different aggregates are published in parallel. A record that fails and is retried later (by the retry queue or the cronjobs) can arrive after newer events of the same aggregate. If strict ordering matters, carry a version in the payload or compare `Outbox-Created-At`.
- **No message without a commit.** The row is published only after your transaction commits; a rolled-back transaction publishes nothing.

## Naming must match everywhere

The table name and column naming are set in three places. They must be identical, or the service silently ignores your events (it filters WAL changes by table name) or the client's inserts fail with `column ... does not exist`.

| Setting | CLI (`outy create migration` / `create schema`) | Client adapter options | Core service env |
|---|---|---|---|
| Table name | `-t, --table-name` (default `outbox`) | `tableName` (default `outbox`) | `TABLE_NAME` (default `outbox`) |
| Column naming | `--column-naming` (default `snake_case`) | `columnNaming` (default `snake_case`) | `COLUMN_NAMING` (default `snake_case`) |

If you keep all defaults, there is nothing to configure.

## Configuration reference

All configuration comes from environment variables (see [`.env.example`](.env.example)). Invalid values fail at startup with a descriptive error.

| Variable | Used by | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | service, cronjobs | **required** | PostgreSQL connection string. Plain URL, no `?replication=database`. |
| `REPLICATION_SLOT_NAME` | service | **required** | Logical replication slot created in step 2. Cronjobs do not need it. |
| `NATS_SERVERS` | service, check-pending | — (or `options.servers` in `publisher.yaml`) | Comma-separated NATS URLs. Overrides `options.servers` in `publisher.yaml`. |
| `TARGET_NATS_URL` | service, check-pending | — | Deprecated alias of `NATS_SERVERS`. |
| `NATS_SUBJECT_PREFIX` | service, check-pending | — (or `options.subjectPrefix` in `publisher.yaml`) | Subject prefix: messages go to `<prefix>.<eventType>`. Overrides `options.subjectPrefix`. |
| `NATS_USER` / `NATS_PASSWORD` | service, check-pending | — | NATS user/password authentication. Override `options.user` / `options.pass`. |
| `NATS_TOKEN` | service, check-pending | — | NATS token authentication. Overrides `options.token`. |
| `NATS_CONNECTION_NAME` | service, check-pending | `outbox-reader` | Client connection name shown in NATS monitoring. Overrides `options.name`. |
| `PUBLISHER_CONFIG_PATH` | service, check-pending | `./publisher.yaml` | Optional YAML publisher config (retry tuning, reconnect options). If the file is missing and `NATS_SERVERS` + `NATS_SUBJECT_PREFIX` are set, env-only mode is used. See [`publisher.example.yaml`](publisher.example.yaml). Only provider `nats` is implemented; `sqs` and `kafka` fail at startup. |
| `TABLE_NAME` | service, cronjobs | `outbox` | Outbox table name. Must match the CLI and client. |
| `COLUMN_NAMING` | service, cronjobs | `snake_case` | `snake_case`, `camelCase` or `PascalCase`. Must match the CLI and client. |
| `PORT` | service | `4599` | Health server port. |
| `LOG_LEVEL` | service, cronjobs | `info` | `trace`, `debug`, `info`, `warn` or `error`. |
| `DB_POOL_SIZE` | service, check-pending | `10` | Database pool size; also the number of aggregates processed in parallel. Integer >= 1. |
| `MAX_OUTBOX_ATTEMPTS` | service, cronjobs | `5` | Publish attempts per record before it becomes `DEAD`. Integer >= 1. |
| `PENDING_EVENTS_THRESHOLD_MINUTES` | check-pending | `10` | Age after which a `PENDING` record is considered lost and republished. Integer >= 1. |
| `PROCESSED_RETENTION_DAYS` | purge | `7` | Delete `PROCESSED` records older than this. Integer >= 1. |
| `DEAD_RETENTION_DAYS` | purge | unset | Delete `DEAD` records older than this. Unset means `DEAD` records are kept forever for inspection. Integer >= 1. |
| `PROMETHEUS_EXPORTER_ENABLED` | service | `true` | Expose Prometheus metrics. Set `false` to push metrics over OTLP instead. |
| `PROMETHEUS_PORT` | service | `9464` | Prometheus metrics port (`/metrics`). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | service | `http://localhost:4318` | OTLP/HTTP endpoint for logs (and metrics when Prometheus is disabled). |
| `OTEL_SERVICE_NAME` | service | `outbox-reader` | `service.name` resource attribute. |
| `OTEL_METRICS_EXPORT_INTERVAL_MS` | service | `30000` | OTLP metrics export interval. |

## Operations

### Cronjobs

The service retries failed publishes in memory a few times. Everything beyond that is handled by three cronjobs, which ship in the same image:

| Cronjob | What it does | Needed? | Suggested schedule |
|---|---|---|---|
| `check-pending-events` | Republishes `PENDING` records older than `PENDING_EVENTS_THRESHOLD_MINUTES`, i.e. events the service lost (crash, lost in-memory retry, WAL acknowledged but not processed). Sequential per aggregate. A record that fails is marked `FAILED`. Needs the NATS settings. | **Required** for reliable delivery | every 5 minutes |
| `reprocess-failed-events` | Re-inserts `FAILED` records as `PENDING`, so the WAL flow publishes them again; records that reached `MAX_OUTBOX_ATTEMPTS` become `DEAD`. Does not talk to NATS. | **Required** for retries beyond the in-memory retry queue | every 5–15 minutes |
| `purge-processed-events` | Deletes `PROCESSED` records older than `PROCESSED_RETENTION_DAYS` in batches of 1000 (and `DEAD` records only if `DEAD_RETENTION_DAYS` is set). Never touches `PENDING`/`FAILED`. | **Recommended**: otherwise the table grows forever | daily, off-peak |

Cronjobs need `DATABASE_URL` (and the same `TABLE_NAME`/`COLUMN_NAMING` as the service) but not `REPLICATION_SLOT_NAME`. Each exits with `0` on success and `1` on a fatal error. Do not let two runs of the same job overlap.

Run them from the image:

```sh
docker run --rm --env-file .env outbox-reader bun packages/core/src/cronjobs/check-pending-events.ts
docker run --rm --env-file .env outbox-reader bun packages/core/src/cronjobs/reprocess-failed-events.ts
docker run --rm --env-file .env outbox-reader bun packages/core/src/cronjobs/purge-processed-events.ts
```

Or from a source checkout: `bun run check-pending-events`, `bun run reprocess-failed-events`, `bun run purge-processed-events`.

Kubernetes example (repeat for the other two jobs with their own schedule and script):

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: outbox-check-pending-events
spec:
  schedule: "*/5 * * * *"
  concurrencyPolicy: Forbid          # never run two sweeps at once
  jobTemplate:
    spec:
      backoffLimit: 0
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: check-pending-events
              image: registry.example.com/outbox-reader:1.0.0
              command: ["bun", "packages/core/src/cronjobs/check-pending-events.ts"]
              envFrom:
                - secretRef:
                    name: outbox-reader-env   # DATABASE_URL, NATS_SERVERS, NATS_SUBJECT_PREFIX, ...
```

### Running the service in production

- Run **one replica** per replication slot (in Kubernetes: `replicas: 1` with `strategy: Recreate`). A second consumer of the same slot is rejected by PostgreSQL.
- Let it restart. On a replication error or a failed startup the service exits with code `1` after a graceful shutdown; the restarted process resumes from the last acknowledged WAL position, so nothing is lost.
- WAL positions are acknowledged only after their events were published (or handed to the retry queue). While the service is down, PostgreSQL keeps WAL for the slot: monitor `pg_replication_slots` and disk usage.
- Use `/live` as the liveness probe and `/ready` as the readiness probe:

```yaml
livenessProbe:  { httpGet: { path: /live,  port: 4599 }, periodSeconds: 10 }
readinessProbe: { httpGet: { path: /ready, port: 4599 }, periodSeconds: 10 }
```

### Record lifecycle

```
PENDING → PROCESSED   publish succeeded
PENDING → FAILED      publish failed after retries
FAILED  → PENDING     reprocess-failed-events re-inserts it (new WAL INSERT)
PENDING/FAILED → DEAD attempts reached MAX_OUTBOX_ATTEMPTS; never retried
```

`DEAD` records need a human: inspect them with `SELECT * FROM outbox WHERE status = 'DEAD';`, fix the cause, and re-insert them as new events if needed.

## Health endpoints and metrics

Served on `PORT` (default `4599`):

| Endpoint | Response |
|---|---|
| `GET /live` | Always `200 {"status":"ok"}` while the process is up |
| `GET /ready` | `200 {"status":"ok","checks":{"replication":"ok","publisher":"ok","database":"ok"}}` when every check passes; `503 {"status":"fail","checks":{...}}` otherwise |
| `GET /health` | Alias of `/ready` |

Checks: `replication` (slot subscribed, no replication error), `publisher` (connected to NATS), `database` (`SELECT 1` answers).

Prometheus metrics are served at `http://<host>:9464/metrics` (`PROMETHEUS_PORT`). Logs are written to stdout and exported over OTLP to `OTEL_EXPORTER_OTLP_ENDPOINT`.

## Troubleshooting

| Error or symptom | Cause | Fix |
|---|---|---|
| `logical decoding requires wal_level >= logical` | PostgreSQL not configured for logical replication | Set `wal_level = logical` (plus `max_wal_senders`, `max_replication_slots`) and restart PostgreSQL. Check with `SHOW wal_level;`. |
| `could not access file "wal2json": No such file or directory` | wal2json plugin not installed on the server | Install `postgresql-<version>-wal2json` or use an image with it ([details](#install-wal2json)). |
| `option "actions" ... is unknown` (or similar wal2json option error) | wal2json older than 2.0 | Upgrade wal2json to 2.x. |
| `must be superuser or replication role to use replication slots` / `permission denied to use replication slots` | User lacks the `REPLICATION` role | `ALTER USER <user> REPLICATION;` |
| `replication slot "<name>" does not exist` (service exits 1) | Slot not created, or `REPLICATION_SLOT_NAME` differs from the slot name | Run `outy setup replication -s <name>` (step 2) or fix `REPLICATION_SLOT_NAME`. |
| `extension "pg_uuidv7" is not available` (running the step 3 SQL) | The generated table uses `uuid_generate_v7()` from the pg_uuidv7 extension | Install [pg_uuidv7](https://github.com/fboulnois/pg_uuidv7) on the server, or drop the `CREATE EXTENSION` line and the `id` default (the client always supplies the id). |
| `replication slot "<name>" is active for PID ...` | Another instance is consuming the slot | Run a single instance per slot. |
| `Failed to read publisher config at "./publisher.yaml"` | No `publisher.yaml` and env-only mode not enabled | Set both `NATS_SERVERS` and `NATS_SUBJECT_PREFIX`, or mount a `publisher.yaml` at `PUBLISHER_CONFIG_PATH`. |
| Publishes fail with `503` / `no responders available` | No JetStream stream covers the subject | Create a stream with subjects `<prefix>.>` (step 4). Check that `NATS_SUBJECT_PREFIX` matches the stream's subjects. |
| `/ready` returns 503 with `"publisher":"fail"` | Cannot connect to NATS | Check `NATS_SERVERS`, credentials and network access. |
| `Environment variable DATABASE_URL is required` / `... must be an integer` | Missing or invalid env var | Fix the variable named in the message. |
| Service is healthy but events stay `PENDING` and nothing is published | Table or column naming differs between client, CLI and service | Make `TABLE_NAME`/`COLUMN_NAMING` match the table ([naming](#naming-must-match-everywhere)). The `check-pending-events` cronjob republishes stale `PENDING` records once fixed. |
| Client insert fails with `relation "outbox" does not exist` or `column ... does not exist` | Table not created, or client `tableName`/`columnNaming` differ from the schema | Run step 3 with the same options you pass to the adapter. |
| Records end up `DEAD` | Publishing failed `MAX_OUTBOX_ATTEMPTS` times | Fix the cause (usually NATS/stream config), then re-insert the events. |
| PostgreSQL disk keeps growing | The slot retains WAL while the service is down or the slot is unused | Bring the service back, or drop the unused slot with `pg_drop_replication_slot`. |

## PostgreSQL setup in detail

### Configure `postgresql.conf`

```
wal_level = logical
max_wal_senders = 10
max_replication_slots = 10
```

These settings require a **server restart**.

- **Managed or bare-metal PostgreSQL:** edit `postgresql.conf`, then restart (`pg_ctl restart` or `systemctl restart postgresql`). On managed services (RDS, Cloud SQL, Azure) enable logical decoding through the provider's parameter group / flags.
- **Docker CLI:** pass the settings as `-c` flags:
  ```sh
  docker run -d -e POSTGRES_PASSWORD=secret -p 5432:5432 postgres-wal2json \
    -c wal_level=logical -c max_wal_senders=10 -c max_replication_slots=10
  ```
- **docker-compose:** add a `command` to your `db` service (active from container start, no extra restart):
  ```yaml
  services:
    db:
      build: { context: ., dockerfile: Dockerfile.pg }   # image with wal2json, see below
      environment:
        POSTGRES_PASSWORD: secret
      command: ["postgres", "-c", "wal_level=logical", "-c", "max_wal_senders=10", "-c", "max_replication_slots=10"]
  ```

### Grant the `REPLICATION` role

```sql
CREATE USER outbox_user WITH LOGIN REPLICATION PASSWORD 'secret';
-- or, for an existing user:
ALTER USER existing_user REPLICATION;
```

With Docker you can run this once (`docker exec -it <container> psql -U postgres -c "..."`) or mount an init script at `/docker-entrypoint-initdb.d/init.sql`, which runs on the first start of an empty data directory.

### Install wal2json

The official `postgres` image does not include `wal2json`.

- **Debian/Ubuntu:** `sudo apt-get install postgresql-17-wal2json` (match your PostgreSQL major version).
- **Docker:** build a custom image, like this repository's [`Dockerfile.pg`](Dockerfile.pg):
  ```dockerfile
  FROM postgres:17-bullseye
  RUN apt-get update \
      && apt-get install -y postgresql-17-wal2json \
      && rm -rf /var/lib/apt/lists/*
  ```
  ```sh
  docker build -f Dockerfile.pg -t postgres-wal2json .
  ```

Verify the plugin is installed by creating the slot (step 2): it fails with `could not access file "wal2json"` if the plugin is missing.

## Development

```sh
bun install
docker compose up -d          # PostgreSQL + NATS (see above)
bun run start                 # service with hot reload
bun run test                  # all packages
cd packages/core && bun test test/outbox-processor.test.ts   # one file
bun run lint
```

Contributor guidance lives in [CLAUDE.md](CLAUDE.md) and each package's `CLAUDE.md`. Commits follow [Conventional Commits](https://www.conventionalcommits.org/).

## License

[MIT](LICENSE)
