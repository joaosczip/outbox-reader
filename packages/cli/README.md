# @outbox-reader/cli

Developer tooling for the Transactional Outbox pattern. Provides a CLI to generate Prisma schemas and set up PostgreSQL logical replication.

## Installation

```bash
bun add @outbox-reader/cli
```

Or run directly without installing:

```bash
bunx @outbox-reader/cli --help
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
  @@index([status])
  @@index([createdAt])
  @@index([sequenceNumber])
}
```

### `generate-config`

Writes a sample JSON config file you can customize and pass to `schema -c`.

```
outbox-schema generate-config [options]

Options:
  -o, --output  Output path for the config file  [default: "./outbox-config.json"]
```

**Example:**

```bash
outbox-schema generate-config -o ./config/outbox.json
```

Generated file:

```json
{
  "schemaPath": "./prisma/schema.prisma",
  "modelName": "OutboxRecord",
  "tableName": "outbox",
  "generateMigration": true,
  "migrationName": "add_outbox_table",
  "customFields": {}
}
```

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
outbox-schema setup-replication [options]

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
outbox-schema setup-replication \
  -u outbox_user \
  -P secret \
  -d my_database \
  -s outbox_slot
```

If the slot already exists the command exits successfully with an informational message. If the connection or slot creation fails, it exits with code 1 and prints a hint about the `REPLICATION` role.

### `create migration`

Generates a database migration for the outbox table. When no `--target` is given, it prints a plain SQL `CREATE TABLE` statement to stdout that you can run manually.

```
outbox create migration [options]

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
outbox create migration

# Save SQL to a file
outbox create migration --output ./migrations/create_outbox.sql

# Append model to schema.prisma and run prisma migrate dev
outbox create migration --target prisma
outbox create migration --target prisma --schema-path ./database/schema.prisma

# Write a timestamped Sequelize migration file
outbox create migration --target sequelize
outbox create migration --target sequelize --migrations-path ./db/migrations
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

CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status);
CREATE INDEX IF NOT EXISTS idx_outbox_created_at ON outbox(created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_sequence_number ON outbox(sequence_number);
```

The Sequelize migration file is a standard `queryInterface.createTable` / `dropTable` module placed in the migrations directory, named `<timestamp>-<migration-name>.js`. The migrations directory is discovered from `.sequelizerc` (`migrations-path` key), falling back to `./migrations/`.

### `setup client`

Installs the `@outbox-reader/client` package using the auto-detected package manager.

```
outbox setup client
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
outbox setup client
```

## Global flags

```
--help     Show help
--version  Show version
```
