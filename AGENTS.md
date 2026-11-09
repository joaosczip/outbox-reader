# AGENTS.md: integrating Outbox Reader into a project

This guide is for AI agents (and humans) adding the transactional outbox to **another** application. It is not contributor documentation; for working on this repository itself, read [CLAUDE.md](CLAUDE.md).

Full explanations live in the [root README](README.md). This file is the condensed, ordered version.

## What you are setting up

1. The application inserts an event row into an `outbox` table **inside the same database transaction** as its domain write, using `@joaosczip/outy-client`.
2. The Outbox Reader service (this repo's `packages/core`, run as a Docker container) reads those inserts from the PostgreSQL WAL and publishes them to NATS JetStream.
3. Consumers subscribe to the JetStream stream and must handle duplicates.

## Decision points (settle these first)

| Decision | Options | Default |
|---|---|---|
| ORM in the target app | Prisma → `PrismaAdapter`; Sequelize → `SequelizeAdapter`; anything else → implement `OutboxAdapter` (see [client README](packages/client/README.md)) | — |
| How the table is created | `outy create migration --target prisma`, `--target sequelize`, or no target (prints SQL to stdout) | match the app's migration tool |
| Table name / column naming | any name; `snake_case`, `camelCase`, `PascalCase` | `outbox` / `snake_case` |
| NATS subject prefix and stream | prefix `P` requires a stream with subjects `P.>` | `events`, stream `OUTBOX` |
| Where the service runs | Docker image built from `packages/core/Dockerfile` (not on npm) | one replica per slot |

Keep the defaults unless the project has a reason not to: then nothing needs to be configured for naming.

## Install

```sh
# client, in the application (Node.js >= 18 or Bun)
npm install @joaosczip/outy-client        # or: bun add @joaosczip/outy-client

# CLI, no install needed (requires Bun on the machine running it)
bunx @joaosczip/outy-cli --help

# service image, from a checkout of this repository
git clone https://github.com/joaosczip/outbox-reader.git
docker build -f outbox-reader/packages/core/Dockerfile -t outbox-reader outbox-reader
```

## Ordered checklist

Do not skip a verification: a later step fails in confusing ways when an earlier one is wrong.

| # | Step | Command | Verify |
|---|---|---|---|
| 1 | PostgreSQL: `wal_level = logical`, `wal2json` installed, user with `REPLICATION` (restart needed) | see [README: PostgreSQL setup](README.md#postgresql-setup-in-detail) | `psql "$DATABASE_URL" -c 'SHOW wal_level;'` → `logical` |
| 2 | Replication slot | `PGPASSWORD=… bunx @joaosczip/outy-cli setup replication -h <host> -p 5432 -u <user> -d <db> -s outbox_slot` | prints `Replication slot "outbox_slot" created successfully.`; `SELECT slot_name, plugin FROM pg_replication_slots;` → `outbox_slot \| wal2json` |
| 3 | Outbox table | `bunx @joaosczip/outy-cli create migration [--target prisma\|sequelize] [-t outbox] [--column-naming snake_case]`, then apply it with the app's migration tool (or `psql -f` for the SQL output) | `psql "$DATABASE_URL" -c '\d outbox'` lists the table |
| 4 | JetStream stream | `nats stream add OUTBOX --subjects 'events.>' --dupe-window 2m --defaults` | `nats stream info OUTBOX` shows subjects `events.>` |
| 5 | Run the service | `docker run -d -e DATABASE_URL=… -e REPLICATION_SLOT_NAME=outbox_slot -e NATS_SERVERS=nats://…:4222 -e NATS_SUBJECT_PREFIX=events -p 4599:4599 outbox-reader` | `curl -s localhost:4599/ready` → `{"status":"ok",…}` |
| 6 | Write events in the app | see snippet below | row reaches `status = 'PROCESSED'`; `nats stream info OUTBOX` message count increases |
| 7 | Consumer | durable consumer + idempotent handler (see [README step 7](README.md#7-consume-the-events)) | handler receives the event; `nats consumer info OUTBOX <name>` ack floor advances |
| 8 | Cronjobs | schedule `check-pending-events` (every 5 min), `reprocess-failed-events` (every 5–15 min), `purge-processed-events` (daily): `docker run --rm --env-file .env outbox-reader bun packages/core/src/cronjobs/<name>.ts` | each run exits `0` |

Prisma snippet:

```ts
import { OutboxClient, PrismaAdapter } from "@joaosczip/outy-client";

const outbox = new OutboxClient(new PrismaAdapter({ tableName: "outbox", columnNaming: "snake_case" }));

await prisma.$transaction(async (tx) => {
  const order = await tx.order.create({ data });
  await outbox.create({ aggregateId: order.id, aggregateType: "Order", eventType: "order.created", payload: order }, tx);
});
```

Sequelize: `new OutboxClient(new SequelizeAdapter(sequelize, { tableName, columnNaming }))` and pass the `sequelize.transaction(...)` transaction `t` as the second argument of `outbox.create`. Both adapters also accept `{ underlying: tx }`. An optional `id` in the event sets the record id.

## Naming-consistency rule

The table name and column naming must be **identical** in all three places:

- CLI: `-t/--table-name` and `--column-naming` of `outy create migration` (and `outy create schema`)
- Client: `tableName` and `columnNaming` adapter options
- Service and cronjobs: `TABLE_NAME` and `COLUMN_NAMING` env vars

A mismatch does not crash the service: it is healthy but publishes nothing, because it filters the WAL by table name.

## Message contract (what consumers receive)

- Subject: `<NATS_SUBJECT_PREFIX>.<eventType>` (e.g. `events.order.created`). Keep `eventType` subject-safe: no spaces, `*` or `>`.
- Body: the JSON payload.
- `Nats-Msg-Id`: the outbox record id (JetStream dedup within the stream's duplicate window, default 2m).
- Headers: `Outbox-Id`, `Outbox-Aggregate-Id`, `Outbox-Aggregate-Type`, `Outbox-Event-Type`, `Outbox-Created-At` (ISO-8601).
- Delivery is at-least-once. Per aggregate, events are published in commit order; a retried record can arrive after newer ones.

Details: [README: message contract](README.md#message-contract).

## Common pitfalls

| Symptom | Fix |
|---|---|
| `logical decoding requires wal_level >= logical` | set `wal_level = logical` and **restart** PostgreSQL |
| `could not access file "wal2json"` | install wal2json (>= 2.0) on the database server |
| `library "wal2json" may not be used as an output plugin` | Ubuntu's PostgreSQL packages only allow output plugins listed in `output_plugin_libraries` | Add `output_plugin_libraries = 'wal2json'` to `postgresql.conf` and reload (`SELECT pg_reload_conf();`). |
| service exits 1 saying the slot does not exist | run step 2, and check `REPLICATION_SLOT_NAME` matches `-s` |
| publishes fail with "no responders" | create the stream (step 4) with subjects `<prefix>.>` |
| `Failed to read publisher config` | set both `NATS_SERVERS` and `NATS_SUBJECT_PREFIX` (env-only mode) or mount a `publisher.yaml` |
| `/ready` is OK but rows stay `PENDING` | naming mismatch (see rule above) |
| `null value in column "id"` / `invalid input syntax for type uuid` | every producer must send a UUID id (the client does; raw SQL: `gen_random_uuid()`) |
| `replication slot ... is active for PID` | only one service instance per slot |

More in [README: troubleshooting](README.md#troubleshooting).

## Do not

- Do **not** add `?replication=database` to `DATABASE_URL`. The service adds it to its replication connection; the same URL is used for normal queries.
- Do **not** install `@outbox-reader/client` or `@outbox-reader/core` from npm: they do not exist there. The client is `@joaosczip/outy-client`, the CLI is `@joaosczip/outy-cli`, and the service runs from Docker or source.
- Do **not** insert outbox rows outside the domain transaction (no separate connection, no "after commit" hook, no fire-and-forget). Always pass the transaction to `outbox.create`.
- Do **not** write the outbox `CREATE TABLE` by hand. Use `outy create migration`.
- Do **not** assume exactly-once delivery. Consumers must deduplicate on `Outbox-Id` (or `Nats-Msg-Id`) and be idempotent.
- Do **not** run more than one service replica per replication slot, and do not leave an unused slot behind (it retains WAL and fills the disk).
- Do **not** skip the cronjobs: without them, lost or failed events are never retried after the in-memory retries.
- Do **not** use the `sqs` or `kafka` publisher providers: they are not implemented.

## Links

- [README](README.md): canonical documentation and configuration reference
- [packages/cli/README.md](packages/cli/README.md): every `outy` command and flag
- [packages/client/README.md](packages/client/README.md): client API and custom adapters
- [packages/core/README.md](packages/core/README.md): service internals, Docker, programmatic use
