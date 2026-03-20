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
├── config.ts                     — package-level config (e.g. table name defaults)
├── models/
│   └── outbox-status.ts          — OutboxStatus enum (PENDING, PROCESSED, FAILED)
├── types/
│   ├── adapter.ts                — OutboxAdapter<TTransaction> interface
│   ├── outbox-event.ts           — CreateOutboxEvent type
│   ├── transaction.ts            — Transaction<T> wrapper type
│   └── index.ts
└── adapters/
    ├── prisma-adapter.ts         — PrismaAdapter: uses $executeRawUnsafe inside a Prisma transaction
    └── sequelize-adapter.ts      — SequelizeAdapter: inserts via Sequelize transaction
```

## Key Classes

- **`OutboxClient<TTransaction>`** (`src/outbox-client.ts`): Thin facade. Accepts an `OutboxAdapter` in its constructor and exposes a single `create(event, transaction)` method. The generic `TTransaction` is inferred from the adapter.
- **`PrismaAdapter`** (`src/adapters/prisma-adapter.ts`): Implements `OutboxAdapter<PrismaTransactionClient>`. Inserts directly via `$executeRawUnsafe` inside a Prisma transaction client.
- **`SequelizeAdapter`** (`src/adapters/sequelize-adapter.ts`): Implements `OutboxAdapter` for Sequelize transactions.

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
    { underlying: tx },
  );
});
```

## Package Exports

- `.` — `OutboxClient` and all shared types
- `./prisma` — `PrismaAdapter` and `PrismaTransactionClient`
- `./sequelize` — `SequelizeAdapter`

## Peer Dependencies

Both `@prisma/client` and `sequelize` are optional peer dependencies. Only install the one matching your ORM.

## Test Structure

Tests live in `test/`. Adapter tests mock the underlying ORM transaction clients.
