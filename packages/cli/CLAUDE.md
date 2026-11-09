# CLAUDE.md — packages/cli

Package: `@joaosczip/outy-cli` (published to npm, MIT)

This is the **developer tooling** package. It provides a CLI (`outy`) for creating the replication slot, generating the outbox table (Prisma schema, SQL or Sequelize migration) and installing the client, plus a programmatic API (`PrismaSchemaGenerator`). Does **not** depend on `packages/core`.

## Commands

```bash
# Run tests
bun test

# Run a single test file
bun test test/prisma-schema-generator.test.ts

# Run the CLI locally (or `bun run outy <args>` from the workspace root)
bun src/cli/index.ts --help

# Build (published artifact)
bun run build

# Lint
bun run lint
```

## Source Structure

```
src/
├── index.ts                          — public API: exports PrismaSchemaGenerator and schema config types
├── cli/
│   ├── index.ts                      — CLI entry point (yargs)
│   └── commands/
│       ├── create/
│       │   ├── index.ts              — "create" command group
│       │   ├── schema.ts             — "create schema" subcommand (Prisma schema generation)
│       │   └── migration.ts          — "create migration" subcommand (SQL/Sequelize migration)
│       └── setup/
│           ├── index.ts              — "setup" command group
│           ├── replication.ts        — "setup replication" subcommand (PostgreSQL replication slot)
│           └── client.ts             — "setup client" subcommand (install outy-client)
├── services/
│   ├── prisma-schema-generator.ts    — generates Prisma model definition for the outbox table
│   ├── prisma-migration-adapter.ts   — adds the model and runs `prisma migrate dev`
│   ├── sql-migration-adapter.ts      — generates raw SQL migration
│   ├── sequelize-migration-adapter.ts — generates Sequelize migration file
│   ├── migration-adapter.ts          — MigrationAdapter interface
│   ├── replication-setup.ts          — creates the PostgreSQL logical replication slot (wal2json)
│   └── client-installer.ts           — installs @joaosczip/outy-client into a target project
├── types/
│   ├── schema-config.ts              — SchemaConfig type (table name, column naming convention)
│   ├── migration-adapter-config.ts   — MigrationAdapterConfig type
│   └── replication-config.ts         — ReplicationConfig type
└── utils/
    ├── column-naming.ts              — column naming convention utilities (snake_case, camelCase, etc.)
    └── replication-messages.ts       — `setup replication` error hints and next steps
```

## Key Services

- **`PrismaSchemaGenerator`** (`src/services/prisma-schema-generator.ts`): Generates the Prisma model block for the outbox table. Accepts a `SchemaConfig` to control the table name and column naming convention.
- **`SqlMigrationAdapter`** (`src/services/sql-migration-adapter.ts`): Generates a raw SQL `CREATE TABLE` migration for the outbox table.
- **`SequelizeMigrationAdapter`** (`src/services/sequelize-migration-adapter.ts`): Generates a Sequelize migration file for the outbox table.
- **`ReplicationSetup`** (`src/services/replication-setup.ts`): Creates a PostgreSQL logical replication slot with the `wal2json` plugin via `pg` (no publication: wal2json does not use one).

## Outbox Indexes

All generators (SQL, Sequelize, Prisma) emit the same two partial indexes, named `idx_<table>_pending_created_at` and `idx_<table>_failed_created_at`, on `created_at` `WHERE status = 'PENDING'` / `'FAILED'`. Do not reintroduce indexes on `status`, `sequence_number` or a plain `created_at`: each one adds an index write to every processed event. The Prisma model uses `@@index(..., where: ...)`, which needs Prisma >= 7.4 with the `partialIndexes` preview feature (the generator enables it). The manual migration for existing tables is in `README.md` ("Outbox indexes").

## CLI Binary

The `outy` binary (`bin/outy.js`) is a Node launcher that runs `bun dist/src/cli/index.js` with `spawnSync` and an argv array (never a shell, so arguments such as passwords are passed literally), propagates the exit code/signal and prints a "requires Bun >= 1.2" error when `bun` is missing. `OUTY_CLI_PATH` overrides the CLI path for `test/outy-bin.test.ts` only. `--version` comes from `package.json`. Commands:
- `outy create schema` — add the outbox model to `schema.prisma` (no migration)
- `outy create migration` — generate the outbox table: SQL (default, stdout/`--output`), `--target prisma` (schema + `prisma migrate dev`) or `--target sequelize`
- `outy setup replication` — create the logical replication slot; prints error hints (`src/utils/replication-messages.ts`) and next steps
- `outy setup client` — install `@joaosczip/outy-client` with the detected package manager

`README.md` documents every command from its real `--help` output; update it whenever an option changes.

## Test Structure

Tests live in `test/`. Each service has a corresponding unit test file.
