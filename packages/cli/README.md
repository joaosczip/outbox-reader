# @joaosczip/outy-cli

Developer tooling for the Transactional Outbox pattern. Provides a CLI to generate Prisma schemas and set up PostgreSQL logical replication.

## Installation

```bash
bun add @joaosczip/outy-cli
```

Or run directly without installing:

```bash
bunx @joaosczip/outy-cli --help
```

## Commands

### `schema` (default)

Generates the outbox `model` block in your Prisma schema and optionally runs `prisma migrate dev`.

```
outbox-schema [schema] [options]

Options:
  -s, --schema-path    Path to schema.prisma file      [default: "./prisma/schema.prisma"]
  -m, --model-name     Prisma model name               [default: "OutboxRecord"]
  -t, --table-name     Database table name             [default: "outbox"]
      --migration-name Migration name                  [default: "add_outbox_table"]
  -c, --config         Path to a JSON config file
      --skip-migration Skip running prisma migrate dev [default: false]
```

**Examples:**

```bash
# Generate schema with defaults (creates/updates ./prisma/schema.prisma)
outbox-schema

# Custom schema path
outbox-schema -s ./database/schema.prisma

# Use a config file
outbox-schema -c ./outbox-config.json

# Generate schema only, no migration
outbox-schema --skip-migration

# Custom model and table names
outbox-schema -m OutboxEvent -t outbox_events
```

The command appends the following model to your schema (or creates the file if it doesn't exist):

```prisma
model OutboxRecord {
  id             String    @id @default(cuid())
  aggregateId    String    @map("aggregate_id")
  aggregateType  String    @map("aggregate_type")
  eventType      String    @map("event_type")
  payload        Json
  sequenceNumber BigInt?   @map("sequence_number")
  createdAt      DateTime  @default(now()) @map("created_at")
  processedAt    DateTime? @map("processed_at")
  status         String    @default("PENDING")
  attempts       Int       @default(0)

  @@map("outbox")
  @@index([createdAt], map: "idx_outbox_pending_created_at", where: { status: "PENDING" })
  @@index([createdAt], map: "idx_outbox_failed_created_at", where: { status: "FAILED" })
  @@index([processedAt], map: "idx_outbox_processed_processed_at", where: { status: "PROCESSED" })
  @@index([createdAt], map: "idx_outbox_dead_created_at", where: { status: "DEAD" })
}
```

The partial indexes require **Prisma ORM >= 7.4** with the `partialIndexes` preview feature. The generator adds `previewFeatures = ["partialIndexes"]` to the first `generator` block of your schema (and new schema files leave the connection URL to `prisma.config.ts`, as Prisma 7 requires). See [Outbox indexes](#outbox-indexes).


`customFields` lets you append extra Prisma fields to the model, e.g.:

```json
{
  "customFields": {
    "tenantId": "String?",
    "version": "Int @default(1)"
  }
}
```

### `setup-replication`

Connects to a PostgreSQL instance and creates a logical replication slot using the `wal2json` plugin. This automates the manual step typically done after configuring `postgresql.conf`.

```
outy setup-replication [options]

Options:
  -h, --host       PostgreSQL host      [default: "localhost"]
  -p, --port       PostgreSQL port      [default: 5432]
  -u, --user       PostgreSQL user      [required]
  -P, --password   PostgreSQL password  [required] (also reads $PGPASSWORD)
  -d, --database   PostgreSQL database  [required]
  -s, --slot-name  Replication slot name [required]
```

**Prerequisites (require a server restart — must be done manually):**

Add the following to `postgresql.conf`:

```
wal_level = logical
max_wal_senders = 10
max_replication_slots = 10
```

The PostgreSQL user must have `LOGIN` and `REPLICATION` roles:

```sql
CREATE USER outbox_user WITH LOGIN REPLICATION PASSWORD 'secret';
```

**Example:**

```bash
outy setup replication \
  -u outbox_user \
  -P secret \
  -d my_database \
  -s outbox_slot
```

If the slot already exists the command exits successfully with an informational message. If the connection or slot creation fails, it exits with code 1 and prints a hint about the `REPLICATION` role.

### `create migration`

Generates a database migration for the outbox table. When no `--target` is given, it prints a plain SQL `CREATE TABLE` statement to stdout that you can run manually.

```
outy create migration [options]

Options:
  -T, --target          Migration target: prisma | sequelize | sql  [default: sql (stdout)]
  -t, --table-name      Database table name                         [default: "outbox"]
      --migration-name  Name for the migration                      [default: "add_outbox_table"]

  Prisma only:
  -s, --schema-path     Path to schema.prisma file                  [default: "./prisma/schema.prisma"]
  -m, --model-name      Prisma model name                           [default: "OutboxRecord"]
  -c, --config          Path to a JSON config file

  Sequelize only:
      --migrations-path Path to the migrations directory            [default: auto-detected from .sequelizerc]

  SQL only:
  -o, --output          Write SQL to this file instead of stdout
```

**Examples:**

```bash
# Print SQL to stdout (no ORM dependency)
outy create migration

# Save SQL to a file
outy create migration --output ./migrations/create_outbox.sql

# Append model to schema.prisma and run prisma migrate dev
outy create migration --target prisma
outy create migration --target prisma --schema-path ./database/schema.prisma

# Write a timestamped Sequelize migration file
outy create migration --target sequelize
outy create migration --target sequelize --migrations-path ./db/migrations
```

The SQL output looks like:

```sql
CREATE TABLE IF NOT EXISTS outbox (
  id              UUID PRIMARY KEY,
  aggregate_id    TEXT NOT NULL,
  aggregate_type  TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  payload         JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'PENDING',
  attempts        INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  processed_at    TIMESTAMP,
  sequence_number BIGINT
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending_created_at ON outbox(created_at) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_outbox_failed_created_at ON outbox(created_at) WHERE status = 'FAILED';
CREATE INDEX IF NOT EXISTS idx_outbox_processed_processed_at ON outbox(processed_at) WHERE status = 'PROCESSED';
CREATE INDEX IF NOT EXISTS idx_outbox_dead_created_at ON outbox(created_at) WHERE status = 'DEAD';
```

The Sequelize migration file is a standard `queryInterface.createTable` / `dropTable` module placed in the migrations directory, named `<timestamp>-<migration-name>.js`. The migrations directory is discovered from `.sequelizerc` (`migrations-path` key), falling back to `./migrations/`.

### Outbox indexes

All targets (SQL, Sequelize, Prisma) create the same four partial indexes, in every column naming mode:

| Index | Columns | Predicate | Serves |
| --- | --- | --- | --- |
| `idx_<table>_pending_created_at` | `created_at` | `status = 'PENDING'` | stale `PENDING` sweeper (`check-pending-events`) |
| `idx_<table>_failed_created_at` | `created_at` | `status = 'FAILED'` | `reprocess-failed-events` |
| `idx_<table>_processed_processed_at` | `processed_at` | `status = 'PROCESSED'` | retention purge of `PROCESSED` rows (`purge-processed-events`) |
| `idx_<table>_dead_created_at` | `created_at` | `status = 'DEAD'` | retention purge of `DEAD` rows (`purge-processed-events`, opt-in) |

The lookup by id (`WHERE id = ANY($1) AND status IN (...)`) uses the primary key. There is no index on `status` (low selectivity, almost every row ends `PROCESSED`), `sequence_number` (never queried) or a plain `created_at`. Each of those got a new entry on every processed event. Because `status` is part of the partial index predicates, status updates are still not HOT. The pending and failed indexes stay small: a row that leaves `PENDING` or `FAILED` is not written into them.

#### Migrating an existing installation

Tables created with an older CLI version have `status`, `created_at` and `sequence_number` indexes. Run this SQL manually, outside a transaction (`CONCURRENTLY` cannot run inside one; with `psql`, do not use `--single-transaction`). Create the new indexes first so the cronjobs are never left without one:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outbox_pending_created_at ON outbox(created_at) WHERE status = 'PENDING';
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_outbox_failed_created_at ON outbox(created_at) WHERE status = 'FAILED';
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

Prisma users: after running the SQL, replace the three `@@index` lines in the model with the four partial indexes in the model example above, enable `partialIndexes`, generate the migration with `prisma migrate dev --create-only`, check that it matches what you already ran, and mark it applied with `prisma migrate resolve --applied <migration>`.

`purge-processed-events` deletes terminal rows older than the retention and uses the two indexes above. `idx_<table>_processed_processed_at` range-scans `PROCESSED` rows by `processed_at` and receives one index entry per row that becomes `PROCESSED`. `idx_<table>_dead_created_at` range-scans `DEAD` rows by `created_at` and stays small, because only records that exhaust their attempts are marked `DEAD`. `PROCESSED` rows normally have `processed_at` set. A row whose `processed_at` is null is deleted by a fallback (`status = 'PROCESSED' AND processed_at IS NULL AND created_at < cutoff`) that has no dedicated index and may scan. Keep the pending and failed indexes: the sweeper and the reprocess cron still use them.

### `setup client`

Installs the `@outbox-reader/client` package using the auto-detected package manager.

```
outy setup client
```

The command detects the package manager by looking for lockfiles in the current directory:

| Lockfile | Package manager | Install command |
|----------|----------------|-----------------|
| `bun.lock` / `bun.lockb` | bun | `bun add` |
| `yarn.lock` | yarn | `yarn add` |
| `pnpm-lock.yaml` | pnpm | `pnpm add` |
| `package-lock.json` (or none) | npm | `npm install` |

**Example:**

```bash
# Auto-detects package manager and installs @outbox-reader/client
outy setup client
```

## Global flags

```
--help     Show help
--version  Show version
```
