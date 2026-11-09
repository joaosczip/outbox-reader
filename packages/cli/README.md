# @joaosczip/outy-cli

Developer tooling for the [outbox-reader](https://github.com/joaosczip/outbox-reader) Transactional Outbox service. The `outy` CLI creates the PostgreSQL logical replication slot, generates the outbox table (SQL, Prisma or Sequelize) and installs the client library into your application.

## Installation

The CLI runs on [Bun](https://bun.sh) **>= 1.2**. The `outy` launcher can be started from any shell, but it hands off to `bun`, so Bun must be on your `PATH` (otherwise `outy` exits with an error pointing to https://bun.sh).

Run it without installing:

```bash
bunx @joaosczip/outy-cli --help
```

Or add it to your project and use the `outy` binary:

```bash
bun add -d @joaosczip/outy-cli
bunx outy --help
```

The examples below use `outy`; replace it with `bunx @joaosczip/outy-cli` if you did not install the package.

## Getting started

1. **Prepare PostgreSQL** (server-side, once). In `postgresql.conf` set `wal_level = logical`, `max_wal_senders >= 1` and `max_replication_slots >= 1`, then restart the server. Install the [wal2json](https://github.com/eulerto/wal2json) output plugin (e.g. `apt install postgresql-<version>-wal2json`) output plugin. Create a user with the `LOGIN` and `REPLICATION` roles. See the [full guide](https://github.com/joaosczip/outbox-reader#outy-setup-replication).
2. **Create the replication slot**: `PGPASSWORD=... outy setup replication -u <user> -d <database> -s <slot>`.
3. **Create the outbox table**: `outy create migration` (plain SQL), or `--target prisma` / `--target sequelize`.
4. **Install the client in your application**: `outy setup client`.
5. **Run the outbox-reader service** with `REPLICATION_SLOT_NAME=<slot>` and `DATABASE_URL` pointing at the same database.

### Table and column naming must match everywhere

`--table-name` and `--column-naming` decide the physical table and column names. The client adapter options (`tableName`, `columnNaming`) and the outbox-reader service environment (`TABLE_NAME`, `COLUMN_NAMING`) must use the **same values**, or events are written to (or read from) a table that does not exist. The table name is converted with the naming convention too, e.g. `--table-name outbox_events` becomes `outbox_events` (snake_case), `outboxEvents` (camelCase) or `OutboxEvents` (PascalCase).

| `--column-naming` | Table (`outbox`) | Columns |
| --- | --- | --- |
| `snake_case` (default) | `outbox` | `aggregate_id`, `aggregate_type`, `event_type`, `created_at`, `processed_at`, `sequence_number` |
| `camelCase` | `outbox` | `aggregateId`, `aggregateType`, `eventType`, `createdAt`, `processedAt`, `sequenceNumber` |
| `PascalCase` | `Outbox` | `AggregateId`, `AggregateType`, `EventType`, `CreatedAt`, `ProcessedAt`, `SequenceNumber` |

`id`, `payload`, `status` and `attempts` keep the same name in every mode.

## Commands

```
outy <command>

Commands:
  outy create <command>  Create outbox artifacts
  outy setup <command>   Configure infrastructure for the outbox pattern

Options:
  --help     Show help                                                 [boolean]
  --version  Show version number                                       [boolean]
```

| Command | What it does |
| --- | --- |
| [`outy setup replication`](#outy-setup-replication) | Create the PostgreSQL logical replication slot (wal2json) |
| [`outy create migration`](#outy-create-migration) | Generate the outbox table as SQL, a Prisma migration or a Sequelize migration |
| [`outy create schema`](#outy-create-schema) | Add the outbox model to `schema.prisma` without running a migration |
| [`outy setup client`](#outy-setup-client) | Install `@joaosczip/outy-client` into the current project |

### `outy setup replication`

Connects to PostgreSQL and creates a logical replication slot with the `wal2json` plugin. The server settings above must already be in place (they need a restart, so the CLI cannot apply them for you).

```
outy setup replication

Create a PostgreSQL logical replication slot

Options:
      --help       Show help                                           [boolean]
      --version    Show version number                                 [boolean]
  -h, --host       PostgreSQL host               [string] [default: "localhost"]
  -p, --port       PostgreSQL port                      [number] [default: 5432]
  -u, --user       PostgreSQL user                           [string] [required]
  -P, --password   PostgreSQL password. Prefer the PGPASSWORD env var: command-l
                   ine arguments are visible to other users (e.g. in `ps`)
                                      [string] [required] [default: $PGPASSWORD]
  -d, --database   PostgreSQL database                       [string] [required]
  -s, --slot-name  Replication slot name                     [string] [required]
```

`-P/--password` is only required when `PGPASSWORD` is not set. Prefer `PGPASSWORD`: command-line arguments are visible to other users of the machine (e.g. in `ps`) and end up in your shell history.

```bash
PGPASSWORD=secret outy setup replication -u outbox_user -d my_database -s outbox_slot
```

- If the slot already exists, the command exits with code 0 and changes nothing.
- On success it prints the next steps: create the outbox table (`outy create migration`), configure the service with `REPLICATION_SLOT_NAME=<slot>`, and install the client (`outy setup client`).
- On failure it exits with code 1 and prints a hint for the error: `wal_level` not `logical`, wal2json not installed, missing `REPLICATION` role (`ALTER ROLE <user> WITH REPLICATION;`), no free replication slot (`max_replication_slots`), connection refused, authentication failure, unknown database or invalid slot name. Slot names may only contain lower-case letters, numbers and underscores.

### `outy create migration`

Generates the outbox table. Without `--target` it prints plain SQL (same as `--target sql`) to stdout.

```
outy create migration

Generate a database migration for the outbox table

Options:
      --help             Show help                                     [boolean]
      --version          Show version number                           [boolean]
  -T, --target           Migration target ORM/format
                                [string] [choices: "prisma", "sequelize", "sql"]
  -s, --schema-path      Path to schema.prisma file (Prisma only)
                                    [string] [default: "./prisma/schema.prisma"]
  -m, --model-name       Name of the outbox model (Prisma only)
                                              [string] [default: "OutboxRecord"]
  -t, --table-name       Name of the database table [string] [default: "outbox"]
      --migration-name   Name for the migration
                                          [string] [default: "add_outbox_table"]
  -c, --config           Path to configuration file                     [string]
      --migrations-path  Path to migrations directory (Sequelize only)  [string]
  -o, --output           Output file path for SQL (SQL only, defaults to stdout)
                                                                        [string]
      --column-naming    Column naming convention
  [string] [choices: "snake_case", "camelCase", "PascalCase"] [default: "snake_c
                                                                           ase"]
```

What each target does:

- **`sql`** (default): prints the `CREATE TABLE` / `CREATE INDEX` statements, or writes them to `--output`. Run them with your usual migration tool or `psql`.
- **`prisma`**: adds the outbox model to `--schema-path` (creating the file if needed), then runs `npx prisma migrate dev --name <migration-name>`. If that command fails, the model stays in the schema and you can run `prisma migrate dev` yourself.
- **`sequelize`**: writes `<timestamp>-<migration-name>.js` (a `queryInterface.createTable` / `dropTable` module) to `--migrations-path`. Without it, the directory comes from the `migrations-path` key of `.sequelizerc` (or of the file given with `-c/--config`), falling back to `./migrations/`.

`-c/--config` means different things per target: a JSON config file for `prisma` (see [`outy create schema`](#outy-create-schema)), the `.sequelizerc` path for `sequelize`, and it is ignored for `sql`.

```bash
# Print SQL to stdout
outy create migration

# Save SQL to a file, camelCase columns
outy create migration --output ./migrations/create_outbox.sql --column-naming camelCase

# Add the model to schema.prisma and run prisma migrate dev
outy create migration --target prisma --schema-path ./database/schema.prisma

# Write a timestamped Sequelize migration
outy create migration --target sequelize --migrations-path ./db/migrations
```

The default SQL output:

```sql
CREATE TABLE IF NOT EXISTS "outbox" (
  "id" UUID PRIMARY KEY,
  "aggregate_id" VARCHAR(255) NOT NULL,
  "aggregate_type" VARCHAR(255) NOT NULL,
  "event_type" VARCHAR(255) NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "processed_at" TIMESTAMP,
  "requeued_at" TIMESTAMP,
  "sequence_number" BIGINT
);

-- Partial indexes for status-based reads, the per-aggregate predecessor check, and retention.
-- PENDING/FAILED indexes stay small. Becoming PROCESSED adds one entry to the PROCESSED index.
-- The null processed_at purge fallback has no index of its own.
CREATE INDEX IF NOT EXISTS "idx_outbox_pending_created_at" ON "outbox"("created_at") WHERE "status" = 'PENDING';
CREATE INDEX IF NOT EXISTS "idx_outbox_failed_created_at" ON "outbox"("created_at") WHERE "status" = 'FAILED';
CREATE INDEX IF NOT EXISTS "idx_outbox_pending_aggregate_order" ON "outbox"("aggregate_id", "created_at", "id") WHERE "status" = 'PENDING';
CREATE INDEX IF NOT EXISTS "idx_outbox_failed_aggregate_order" ON "outbox"("aggregate_id", "created_at", "id") WHERE "status" = 'FAILED';
CREATE INDEX IF NOT EXISTS "idx_outbox_processed_processed_at" ON "outbox"("processed_at") WHERE "status" = 'PROCESSED';
CREATE INDEX IF NOT EXISTS "idx_outbox_dead_created_at" ON "outbox"("created_at") WHERE "status" = 'DEAD';
```

The `id` column has no database default, so no extension is needed: producers must send the id. The client always generates a UUIDv7; raw SQL producers can use `gen_random_uuid()` (or `uuidv7()` on PostgreSQL 18+). The Prisma model uses `@default(uuid(7))`, generated by Prisma Client.

### `outy create schema`

Adds the outbox model to your Prisma schema (creating the file if it does not exist) **without** running a migration. Use it when you want to review the schema and run `prisma migrate dev` yourself; `outy create migration --target prisma` does both steps.

```
outy create schema

Add the outbox model to your Prisma schema

Options:
      --help           Show help                                       [boolean]
      --version        Show version number                             [boolean]
  -s, --schema-path    Path to schema.prisma file
                                    [string] [default: "./prisma/schema.prisma"]
  -m, --model-name     Name of the outbox model
                                              [string] [default: "OutboxRecord"]
  -t, --table-name     Name of the database table   [string] [default: "outbox"]
  -c, --config         Path to configuration file                       [string]
      --column-naming  Column naming convention
  [string] [choices: "snake_case", "camelCase", "PascalCase"] [default: "snake_c
                                                                           ase"]
```

```bash
outy create schema -s ./database/schema.prisma -m OutboxEvent -t outbox_events
```

The generated model (defaults):

```prisma
model OutboxRecord {
  id              String   @id @db.Uuid @default(uuid(7))
  aggregateId     String   @db.VarChar(255) @map("aggregate_id")
  aggregateType   String   @db.VarChar(255) @map("aggregate_type")
  eventType       String   @db.VarChar(255) @map("event_type")
  payload         Json
  sequenceNumber  BigInt? @map("sequence_number")
  createdAt       DateTime @default(now()) @map("created_at")
  processedAt     DateTime? @map("processed_at")
  requeuedAt      DateTime? @map("requeued_at")
  status          String   @default("PENDING")
  attempts        Int      @default(0)

  @@map("outbox")
  @@index([createdAt], map: "idx_outbox_pending_created_at", where: { status: "PENDING" })
  @@index([createdAt], map: "idx_outbox_failed_created_at", where: { status: "FAILED" })
  @@index([aggregateId, createdAt, id], map: "idx_outbox_pending_aggregate_order", where: { status: "PENDING" })
  @@index([aggregateId, createdAt, id], map: "idx_outbox_failed_aggregate_order", where: { status: "FAILED" })
  @@index([processedAt], map: "idx_outbox_processed_processed_at", where: { status: "PROCESSED" })
  @@index([createdAt], map: "idx_outbox_dead_created_at", where: { status: "DEAD" })
}
```

The partial indexes require **Prisma ORM >= 7.4** with the `partialIndexes` preview feature. The generator adds `previewFeatures = ["partialIndexes"]` to the first `generator` block of your schema (and new schema files leave the connection URL to `prisma.config.ts`, as Prisma 7 requires). See [Outbox indexes](#outbox-indexes).

The JSON file passed with `-c/--config` can add extra fields to the model with `customFields`:

```json
{
  "customFields": {
    "tenantId": "String?",
    "version": "Int @default(1)"
  }
}
```

Command-line options (including their defaults) take precedence over the same keys in the config file.

### `outy setup client`

Installs [`@joaosczip/outy-client`](https://www.npmjs.com/package/@joaosczip/outy-client), the library your application uses to write outbox events in the same transaction as its own changes. Run it from your application's root directory.

```
outy setup client

Install the @joaosczip/outy-client package into the current project

Options:
  --help     Show help                                                 [boolean]
  --version  Show version number                                       [boolean]
```

The package manager is detected from the lockfile in the current directory:

| Lockfile | Command |
| --- | --- |
| `bun.lock` / `bun.lockb` | `bun add @joaosczip/outy-client` |
| `yarn.lock` | `yarn add @joaosczip/outy-client` |
| `pnpm-lock.yaml` | `pnpm add @joaosczip/outy-client` |
| `package-lock.json` (or no lockfile) | `npm install @joaosczip/outy-client` |

Configure the client adapter with the same `tableName` and `columnNaming` you used for `outy create migration` (see [naming](#table-and-column-naming-must-match-everywhere)).

## Outbox indexes

All targets (SQL, Sequelize, Prisma) create the same six partial indexes, in every column naming mode:

| Index | Columns | Predicate | Serves |
| --- | --- | --- | --- |
| `idx_<table>_pending_created_at` | `created_at` | `status = 'PENDING'` | stale `PENDING` sweeper (`check-pending-events`) |
| `idx_<table>_failed_created_at` | `created_at` | `status = 'FAILED'` | `reprocess-failed-events` |
| `idx_<table>_pending_aggregate_order` | `aggregate_id, created_at, id` | `status = 'PENDING'` | predecessor check for a `PENDING` sibling |
| `idx_<table>_failed_aggregate_order` | `aggregate_id, created_at, id` | `status = 'FAILED'` | predecessor check for a `FAILED` sibling |
| `idx_<table>_processed_processed_at` | `processed_at` | `status = 'PROCESSED'` | retention purge of `PROCESSED` rows (`purge-processed-events`) |
| `idx_<table>_dead_created_at` | `created_at` | `status = 'DEAD'` | retention purge of `DEAD` rows (`purge-processed-events`, opt-in) |

`requeued_at` is a nullable timestamp set when a `FAILED` row is requeued. It is used only to decide staleness (a recently requeued row is not stale). It is not the order key (`created_at` is) and it is not the retention age.

The lookup by id (`WHERE id = ANY($1) AND status IN (...)`) uses the primary key. There is no index on `status` (low selectivity, almost every row ends `PROCESSED`), `sequence_number` (never queried) or a plain `created_at`. Each of those got a new entry on every processed event. Because `status` is part of the partial index predicates, status updates are still not HOT. The pending, failed and aggregate-order indexes stay small: a row that leaves `PENDING` or `FAILED` is not written into them. Becoming `PROCESSED` adds one entry to `idx_<table>_processed_processed_at`. The `DEAD` index stays small.

### Aggregate order

`created_at` (then `id`) is the order key for one aggregate. The two aggregate-order indexes exist so the publisher can see whether an older `PENDING` or `FAILED` sibling is still ahead. `DEAD` does not block. The check is per process, immediately before publish; two processes can still both pass it.

### Migrating an existing installation

Tables created with an older CLI version have `status`, `created_at` and `sequence_number` indexes. Run this SQL manually, outside a transaction (`CONCURRENTLY` cannot run inside one; with `psql`, do not use `--single-transaction`). Create the new indexes first so the cronjobs are never left without one:

```sql
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS requeued_at TIMESTAMP;
-- The id must be UUID (the predecessor check compares ids as uuid). Tables created from the
-- old hand-written SQL used VARCHAR(255); convert them (takes an ACCESS EXCLUSIVE lock):
-- ALTER TABLE outbox ALTER COLUMN id TYPE uuid USING id::uuid;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outbox_pending_created_at ON outbox(created_at) WHERE status = 'PENDING';
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outbox_failed_created_at ON outbox(created_at) WHERE status = 'FAILED';
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outbox_pending_aggregate_order ON outbox(aggregate_id, created_at, id) WHERE status = 'PENDING';
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outbox_failed_aggregate_order ON outbox(aggregate_id, created_at, id) WHERE status = 'FAILED';
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outbox_processed_processed_at ON outbox(processed_at) WHERE status = 'PROCESSED';
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outbox_dead_created_at ON outbox(created_at) WHERE status = 'DEAD';

-- Old index names depend on the tool that created the table:
--   SQL target:       idx_outbox_status,  idx_outbox_created_at,     idx_outbox_sequence_number
--   Prisma (default): outbox_status_idx,  outbox_created_at_idx,     outbox_sequence_number_idx
--   Sequelize:        outbox_status,      outbox_created_at,         outbox_sequence_number
-- Check yours with: SELECT indexname FROM pg_indexes WHERE tablename = 'outbox';
DROP INDEX CONCURRENTLY IF EXISTS idx_outbox_status;
DROP INDEX CONCURRENTLY IF EXISTS idx_outbox_created_at;
DROP INDEX CONCURRENTLY IF EXISTS idx_outbox_sequence_number;
```

For camelCase/PascalCase tables, quote the identifiers, e.g. `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_Outbox_pending_created_at" ON "Outbox"("CreatedAt") WHERE "status" = 'PENDING';` and `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_Outbox_processed_processed_at" ON "Outbox"("ProcessedAt") WHERE "status" = 'PROCESSED';`. If `CREATE INDEX CONCURRENTLY` fails, it leaves an `INVALID` index. Drop it and retry.

Prisma users: after running the SQL, replace the old `@@index` lines in the model with the six partial indexes in the model example above, add nullable `requeuedAt` when the table does not have `requeued_at` yet, enable `partialIndexes`, generate the migration with `prisma migrate dev --create-only`, check that it matches what you already ran, and mark it applied with `prisma migrate resolve --applied <migration>`.

`purge-processed-events` deletes terminal rows older than the retention and uses the two indexes above. `idx_<table>_processed_processed_at` range-scans `PROCESSED` rows by `processed_at` and receives one index entry per row that becomes `PROCESSED`. `idx_<table>_dead_created_at` range-scans `DEAD` rows by `created_at` and stays small, because only records that exhaust their attempts are marked `DEAD`. `PROCESSED` rows normally have `processed_at` set. A row whose `processed_at` is null is deleted by a fallback (`status = 'PROCESSED' AND processed_at IS NULL AND created_at < cutoff`) that has no dedicated index and may scan. Keep the pending and failed indexes: the sweeper and the reprocess cron still use them.

## Working on this package

From the repository root, `bun run outy <args>` runs the CLI from source (e.g. `bun run outy create migration --help`), and `bun run schema:generate` runs `outy create schema`. Both run inside `packages/cli`, so relative paths such as `./prisma/schema.prisma` resolve there.
