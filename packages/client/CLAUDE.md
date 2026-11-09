# CLAUDE.md — packages/client

Package: `@joaosczip/outy-client` (published to npm, MIT)

This is the **client library** for writing outbox events transactionally from application code. It provides an ORM-agnostic `OutboxClient` backed by pluggable adapters (Prisma, Sequelize). Does **not** depend on `packages/core` or `packages/cli`.

## Commands

```bash
# Run tests
bun test

# Build (published artifact)
bun run build

# Lint
bun run lint
```

## Source Structure

```
src/
├── index.ts                      — public API: exports OutboxClient and types
├── outbox-client.ts              — OutboxClient<TTransaction>: delegates to the injected adapter
├── models/
│   └── outbox-status.ts          — OutboxStatus enum (PENDING, PROCESSED, FAILED, DEAD)
├── types/
│   ├── adapter.ts                — OutboxAdapter<TTransaction> interface
│   ├── adapter-options.ts        — OutboxTableOptions { tableName?, columnNaming? }
│   ├── outbox-event.ts           — CreateOutboxEvent type (optional `id`)
│   ├── transaction.ts            — Transaction<T> wrapper + TransactionInput<T> (raw tx or wrapper)
│   └── index.ts
├── utils/
│   ├── column-naming.ts          — table/column naming rules (MUST mirror cli/core column-naming.ts) + quoteIdent
│   ├── insert-statement.ts       — validates adapter options, builds the quoted INSERT + bind values
│   ├── uuid-v7.ts                — dependency-free RFC 9562 UUIDv7 (node:crypto), works on Node and Bun
│   └── validation.ts             — event validation, id resolution, raw-tx/wrapper normalisation
└── adapters/
    ├── prisma-adapter.ts         — PrismaAdapter(options?): uses $executeRawUnsafe inside a Prisma transaction
    └── sequelize-adapter.ts      — SequelizeAdapter(sequelize, options?): inserts via sequelize.query with the transaction
```

## Runtime Support

The published build must run on **Node.js >= 18 and Bun**. Never use `Bun.*` globals in `src/`. The package compiles to CommonJS (`tsconfig.json` overrides `module`/`moduleResolution`, `rootDir: "./"` so output lands at `dist/src/*` as declared in `package.json`); `test/integration/node-runtime.test.ts` builds the package and loads every entry point with plain Node.

## Key Classes

- **`OutboxClient<TTransaction>`** (`src/outbox-client.ts`): Thin facade. Accepts an `OutboxAdapter` in its constructor and exposes a single `create(event, transaction)` method. `transaction` is either the raw ORM transaction or `{ underlying: tx }` (detected by an own `underlying` property); it validates the event and always passes the wrapper form to the adapter. The generic `TTransaction` is inferred from the adapter.
- **`PrismaAdapter`** (`src/adapters/prisma-adapter.ts`): Implements `OutboxAdapter<PrismaTransactionClient>`. Inserts directly via `$executeRawUnsafe` inside a Prisma transaction client. `new PrismaAdapter({ tableName?, columnNaming? })`, defaults `outbox` / `snake_case`.
- **`SequelizeAdapter`** (`src/adapters/sequelize-adapter.ts`): Implements `OutboxAdapter` for Sequelize transactions. `new SequelizeAdapter(sequelize, { tableName?, columnNaming? })`.

Both adapters use `event.id` when given (must be a UUID), otherwise generate a UUIDv7, and insert `status = PENDING`, `attempts = 0`, `created_at = NOW()`. Table/column names follow the same rules as the CLI (`--table-name`, `--column-naming`) and core (`TABLE_NAME`, `COLUMN_NAMING`); every identifier is double-quoted.

## Usage Pattern

```ts
import { OutboxClient } from "@joaosczip/outy-client";
import { PrismaAdapter } from "@joaosczip/outy-client/prisma";

const client = new OutboxClient(new PrismaAdapter());

// Inside a Prisma transaction:
await prisma.$transaction(async (tx) => {
  await yourRepo.save(entity, tx);
  await client.create(
    { aggregateId, aggregateType, eventType, payload },
    tx, // or { underlying: tx }
  );
});
```

## Package Exports

- `.` — `OutboxClient` and all shared types
- `./prisma` — `PrismaAdapter`, `PrismaAdapterOptions` and `PrismaTransactionClient`
- `./sequelize` — `SequelizeAdapter`, `SequelizeAdapterOptions`, `SequelizeLike`, `SequelizeTransaction`

## Peer Dependencies

Both `@prisma/client` and `sequelize` are optional peer dependencies. Only install the one matching your ORM.

## Test Structure

Tests live in `test/`. Unit tests (`test/*.test.ts`, `test/adapters/`, `test/utils/`) use the mock factories in `test/mocks/orm.ts` and assert the exact SQL per naming mode, bind values, id format and the forwarded transaction; they need no database. `test/integration/` holds DB tests that run only when `DATABASE_URL` is set (`describe.skipIf`) and the Node build smoke test (skipped when `node` is not on PATH).
