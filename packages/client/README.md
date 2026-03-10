# @outbox-reader/client

ORM-agnostic client for creating transactional outbox events. Uses an adapter pattern so you can plug in any database library (Prisma, Sequelize, Knex, raw `pg`, etc.).

## Install

```bash
npm add @outbox-reader/client
# or
bun add @outbox-reader/client
```

## Usage

```typescript
import { OutboxClient } from "@outbox-reader/client";
import type { OutboxAdapter, Transaction, CreateOutboxEvent } from "@outbox-reader/client";

// 1. Pick (or write) an adapter for your ORM
const adapter = new PrismaAdapter(prisma); // example

// 2. Create the client
const outbox = new OutboxClient(adapter);

// 3. Create outbox events inside your existing transactions
await prisma.$transaction(async (tx) => {
  await tx.order.create({ data: orderData });

  await outbox.create(
    {
      aggregateId: order.id,
      aggregateType: "Order",
      eventType: "order.created",
      payload: order,
    },
    { underlying: tx },
  );
});
```

The `transaction` parameter is **required** — this enforces that outbox inserts always happen inside the same transaction as the domain operation, which is the core guarantee of the transactional outbox pattern.

## Writing an Adapter

Implement the `OutboxAdapter` interface:

```typescript
import type { OutboxAdapter, Transaction, CreateOutboxEvent } from "@outbox-reader/client";

class MyAdapter implements OutboxAdapter<MyTransactionType> {
  async create(event: CreateOutboxEvent, transaction: Transaction<MyTransactionType>): Promise<string> {
    const tx = transaction.underlying;
    // Insert into the outbox table using your ORM/driver
    // Return the created record's ID
  }
}
```

The adapter is responsible for:
- Inserting a row into the `outbox` table with the event fields
- Setting `status` to `PENDING` and generating an ID
- Using the provided transaction to ensure atomicity

## API

### `OutboxClient<TTransaction>`

| Method | Description |
|--------|-------------|
| `constructor(adapter: OutboxAdapter<TTransaction>)` | Create a client with the given adapter |
| `create(event: CreateOutboxEvent, transaction: Transaction<TTransaction>): Promise<string>` | Insert an outbox record within the transaction. Returns the record ID. |

### `CreateOutboxEvent`

| Field | Type | Description |
|-------|------|-------------|
| `aggregateId` | `string` | ID of the domain entity |
| `aggregateType` | `string` | Type of the domain entity (e.g. `"Order"`) |
| `eventType` | `string` | Event name (e.g. `"order.created"`) |
| `payload` | `unknown` | Event payload |

### `Transaction<T>`

| Field | Type | Description |
|-------|------|-------------|
| `underlying` | `T` | The ORM-specific transaction object |

### `OutboxStatus`

Enum with values: `PENDING`, `PROCESSED`, `FAILED`.

## Outbox Table Schema

The adapter should insert into a table with the following structure (column names use `snake_case`):

```sql
CREATE TABLE outbox (
    id VARCHAR(255) PRIMARY KEY,
    aggregate_id VARCHAR(255) NOT NULL,
    aggregate_type VARCHAR(255) NOT NULL,
    event_type VARCHAR(255) NOT NULL,
    payload JSONB NOT NULL,
    sequence_number BIGINT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMP NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    attempts INTEGER NOT NULL DEFAULT 0
);
```
