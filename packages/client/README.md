# @joaosczip/outy-client

ORM-agnostic client for writing [transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html) events from your application code. The event row is inserted **in the same database transaction** as your domain changes; the [outbox-reader](https://github.com/joaosczip/outbox-reader) service then picks it up from the PostgreSQL WAL and publishes it to NATS JetStream.

- Built-in adapters for **Prisma** and **Sequelize**, or write your own for any driver.
- Runs on **Node.js >= 18** and **Bun >= 1.2** (no runtime-specific globals, no dependencies).
- Generates RFC 9562 **UUIDv7** ids (time-ordered), or uses the id you pass.

## Install

```bash
npm install @joaosczip/outy-client
# or
bun add @joaosczip/outy-client
```

`@prisma/client` and `sequelize` are optional peer dependencies — install only the one you use.

## Create the outbox table

Use the CLI to generate the canonical table definition instead of writing it by hand:

```bash
# Print the SQL (default target), or write a Prisma / Sequelize migration
npx @joaosczip/outy-cli create migration --target sql
npx @joaosczip/outy-cli create migration --target prisma
npx @joaosczip/outy-cli create migration --target sequelize

# Custom table / column naming
npx @joaosczip/outy-cli create migration --table-name outbox_events --column-naming camelCase
```

Whatever `--table-name` / `--column-naming` you choose there must also be passed to the adapter (see [Table and column naming](#table-and-column-naming)) and to the outbox-reader service (`TABLE_NAME` / `COLUMN_NAMING`).

## Usage with Prisma

```typescript
import { PrismaClient } from "@prisma/client";
import { OutboxClient } from "@joaosczip/outy-client";
import { PrismaAdapter } from "@joaosczip/outy-client/prisma";

const prisma = new PrismaClient();

// No PrismaClient is passed here: the adapter writes through the
// transaction client you hand to `create()`.
const outbox = new OutboxClient(new PrismaAdapter());

await prisma.$transaction(async (tx) => {
  const order = await tx.order.create({ data: { customerId: "c-1" } });

  const eventId = await outbox.create(
    {
      aggregateId: order.id,
      aggregateType: "Order",
      eventType: "order.created",
      payload: order,
    },
    tx, // the interactive transaction client
  );
});
```

The adapter uses `tx.$executeRawUnsafe` with bind parameters (`$1`, `$2`, …); event values are never interpolated into SQL.

## Usage with Sequelize

```typescript
import { Sequelize } from "sequelize";
import { OutboxClient } from "@joaosczip/outy-client";
import { SequelizeAdapter } from "@joaosczip/outy-client/sequelize";

const sequelize = new Sequelize(process.env.DATABASE_URL as string);
const outbox = new OutboxClient(new SequelizeAdapter(sequelize));

await sequelize.transaction(async (t) => {
  const order = await Order.create({ customerId: "c-1" }, { transaction: t });

  await outbox.create(
    {
      aggregateId: String(order.id),
      aggregateType: "Order",
      eventType: "order.created",
      payload: order.toJSON(),
    },
    t, // the Sequelize transaction
  );
});
```

## Passing the transaction

The transaction argument is **required**: writing the outbox row atomically with your domain changes is the whole point of the pattern. Two forms are accepted:

```typescript
await outbox.create(event, tx);                 // the ORM transaction itself
await outbox.create(event, { underlying: tx }); // explicit wrapper (original API, still supported)
```

A value is treated as the wrapper only when it has an **own** `underlying` property; anything else is treated as the raw transaction. Adapters always receive the wrapper form (`transaction.underlying`).

## Event ids and idempotency

`create()` returns the id of the inserted row. By default a new UUIDv7 is generated. To make producing idempotent, pass your own UUID:

```typescript
await outbox.create({ id: deterministicUuid, aggregateId, aggregateType, eventType, payload }, tx);
```

The id is the table's primary key (a second insert with the same id fails) and is used by outbox-reader as the NATS JetStream dedup `msgID`. Consumers should still be idempotent: delivery is at-least-once.

## Validation

Before any query is sent, `create()` validates the event and throws a descriptive `TypeError` when:

- `aggregateId`, `aggregateType` or `eventType` is not a non-empty string,
- `payload` is `undefined` (use `null` for "no data"), a function or a symbol,
- `id` is given but is not a UUID string,
- the transaction is missing (`undefined` / `null`).

Adapter options are validated in the adapter constructor.

## Table and column naming

Both adapters take an optional options object:

```typescript
new PrismaAdapter({ tableName: "outbox_events", columnNaming: "camelCase" });
new SequelizeAdapter(sequelize, { tableName: "outbox_events", columnNaming: "camelCase" });
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `tableName` | `string` | `"outbox"` | Logical table name, `_`-separated. Must equal the CLI's `--table-name` and core's `TABLE_NAME`. |
| `columnNaming` | `"snake_case" \| "camelCase" \| "PascalCase"` | `"snake_case"` | Must equal the CLI's `--column-naming` and core's `COLUMN_NAMING`. |

The naming applies to the table name too, exactly like the CLI and core do. All identifiers are double-quoted, so mixed case is preserved:

| `tableName` | `columnNaming` | Physical table | Example columns |
|-------------|----------------|----------------|-----------------|
| `outbox` | `snake_case` | `"outbox"` | `"aggregate_id"`, `"event_type"`, `"created_at"` |
| `outbox_events` | `camelCase` | `"outboxEvents"` | `"aggregateId"`, `"eventType"`, `"createdAt"` |
| `outbox` | `PascalCase` | `"Outbox"` | `"AggregateId"`, `"EventType"`, `"CreatedAt"` |

`id`, `payload`, `status` and `attempts` keep the same name in every mode.

## Writing a custom adapter

Implement `OutboxAdapter` for any driver (Knex, Drizzle, raw `pg`, …):

```typescript
import type { CreateOutboxEvent, OutboxAdapter, Transaction } from "@joaosczip/outy-client";
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";

class PgAdapter implements OutboxAdapter<PoolClient> {
  async create(event: CreateOutboxEvent, transaction: Transaction<PoolClient>): Promise<string> {
    const id = event.id ?? randomUUID();
    await transaction.underlying.query(
      `INSERT INTO "outbox" ("id", "aggregate_id", "aggregate_type", "event_type", "payload", "status", "attempts", "created_at")
       VALUES ($1, $2, $3, $4, $5, 'PENDING', 0, NOW())`,
      [id, event.aggregateId, event.aggregateType, event.eventType, JSON.stringify(event.payload)],
    );
    return id;
  }
}

const outbox = new OutboxClient(new PgAdapter());
await outbox.create(event, poolClient); // inside BEGIN ... COMMIT
```

An adapter must:

- insert into the same table/columns the migration created (and core reads),
- set `status` to `PENDING` and `attempts` to `0`,
- use `event.id` when present, otherwise generate one, and return the id,
- run the insert on `transaction.underlying`.

`OutboxClient` validates the event and normalises the transaction before calling your adapter.

## API

### `OutboxClient<TTransaction>`

| Member | Description |
|--------|-------------|
| `new OutboxClient(adapter: OutboxAdapter<TTransaction>)` | Create a client backed by `adapter`. `TTransaction` is inferred from the adapter. |
| `create(event: CreateOutboxEvent, transaction: TTransaction \| Transaction<TTransaction>): Promise<string>` | Validate and insert the event within the transaction. Resolves to the record id. |

### Adapters

| Import | Constructor | Transaction type |
|--------|-------------|------------------|
| `@joaosczip/outy-client/prisma` | `new PrismaAdapter(options?: PrismaAdapterOptions)` | Prisma interactive transaction client (`$executeRawUnsafe`) |
| `@joaosczip/outy-client/sequelize` | `new SequelizeAdapter(sequelize, options?: SequelizeAdapterOptions)` | Sequelize `Transaction` |

Both option types are `OutboxTableOptions` (`{ tableName?, columnNaming? }`). The adapters are also exported from the package root.

### `CreateOutboxEvent`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` (UUID) | no | Record id; generated (UUIDv7) when omitted |
| `aggregateId` | `string` | yes | Id of the domain entity; events of one aggregate are published in order |
| `aggregateType` | `string` | yes | Domain entity name (e.g. `"Order"`) |
| `eventType` | `string` | yes | Event name, used as the NATS subject (e.g. `"order.created"`) |
| `payload` | `unknown` | yes | JSON-serialisable data stored as JSONB (`null` allowed) |

### `Transaction<T>` / `TransactionInput<T>`

| Type | Definition |
|------|------------|
| `Transaction<T>` | `{ readonly underlying: T }` — what adapters receive |
| `TransactionInput<T>` | `T \| Transaction<T>` — what `OutboxClient.create()` accepts |

### `OutboxStatus`

Enum: `PENDING`, `PROCESSED`, `FAILED`, `DEAD` (terminal: max attempts reached, never retried).

### Other exported types

`OutboxAdapter`, `OutboxTableOptions`, `ColumnNaming`, `PrismaTransactionClient`, `PrismaAdapterOptions`, `SequelizeLike`, `SequelizeTransaction`, `SequelizeAdapterOptions`.

## Examples

See [`examples/prisma`](./examples/prisma/index.ts) and [`examples/sequelize`](./examples/sequelize/index.ts).

## License

MIT
