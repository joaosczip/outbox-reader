# CLAUDE.md — packages/cli

Package: `@joaosczip/outy-cli` (published to npm, MIT)

This is the **developer tooling** package. It provides a CLI (`outy`) and a programmatic API for generating Prisma schemas and database migrations for the outbox table. Does **not** depend on `packages/core`.

## Commands

```bash
# Run tests
bun test

# Run a single test file
bun test test/prisma-schema-generator.test.ts

# Run the CLI locally
bun src/cli/index.ts

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
│   ├── prisma-migration-adapter.ts   — generates Prisma migration SQL
│   ├── sql-migration-adapter.ts      — generates raw SQL migration
│   ├── sequelize-migration-adapter.ts — generates Sequelize migration file
│   ├── migration-adapter.ts          — MigrationAdapter interface
│   ├── replication-setup.ts          — creates PostgreSQL replication slot and publication
│   └── client-installer.ts           — installs @joaosczip/outy-client into a target project
├── types/
│   ├── schema-config.ts              — SchemaConfig type (table name, column naming convention)
│   ├── migration-adapter-config.ts   — MigrationAdapterConfig type
│   └── replication-config.ts         — ReplicationConfig type
└── utils/
    └── column-naming.ts              — column naming convention utilities (snake_case, camelCase, etc.)
```

## Key Services

- **`PrismaSchemaGenerator`** (`src/services/prisma-schema-generator.ts`): Generates the Prisma model block for the outbox table. Accepts a `SchemaConfig` to control the table name and column naming convention.
- **`SqlMigrationAdapter`** (`src/services/sql-migration-adapter.ts`): Generates a raw SQL `CREATE TABLE` migration for the outbox table.
- **`SequelizeMigrationAdapter`** (`src/services/sequelize-migration-adapter.ts`): Generates a Sequelize migration file for the outbox table.
- **`ReplicationSetup`** (`src/services/replication-setup.ts`): Creates a PostgreSQL logical replication slot and publication via `pg`.

## CLI Binary

The `outy` binary (`bin/outy.js`) wraps `src/cli/index.ts`. Commands:
- `outy create schema` — generate a Prisma schema snippet for the outbox table
- `outy create migration` — generate a database migration file
- `outy setup replication` — configure PostgreSQL logical replication
- `outy setup client` — install the outy-client package

## Test Structure

Tests live in `test/`. Each service has a corresponding unit test file.
