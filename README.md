# Outbox Reader

A service that implements the [Transactional Outbox Pattern](https://microservices.io/patterns/data/transactional-outbox.html) to reliably publish database changes to NATS JetStream.

## Monorepo Structure

| Package | Name | Description |
|---------|------|-------------|
| `packages/core` | `@outbox-reader/core` | Runtime service — WAL replication, event processing, NATS publishing, DB repository, cronjobs |
| `packages/cli` | `@outbox-reader/cli` | Developer tooling — Prisma schema generator and CLI for setting up the outbox table |

The CLI has no dependency on core and can be used standalone.

## Quick Start

Requirements: Bun v1.2.0+, PostgreSQL with logical replication enabled, NATS with JetStream enabled.

```bash
# Start dependencies (PostgreSQL + NATS)
docker compose up -d

# Copy and fill in environment variables
cp .env.example .env

# Start the service
bun run start
```

## CLI

The `outbox` CLI sets up the outbox table and replication infrastructure.

```
outbox create schema     — add outbox model to schema.prisma (no migration)
outbox create migration  — add model + run prisma migrate dev
outbox create config     — generate a sample outbox-config.json
outbox setup replication — create a PostgreSQL logical replication slot
```

### `outbox create schema`

```
-s, --schema-path   Path to schema.prisma      [default: ./prisma/schema.prisma]
-m, --model-name    Outbox model name           [default: OutboxRecord]
-t, --table-name    Database table name         [default: outbox]
-c, --config        Path to configuration file
```

### `outbox create migration`

```
-s, --schema-path   Path to schema.prisma      [default: ./prisma/schema.prisma]
-m, --model-name    Outbox model name           [default: OutboxRecord]
-t, --table-name    Database table name         [default: outbox]
    --migration-name  Migration name            [default: add_outbox_table]
-c, --config        Path to configuration file
```

### `outbox create config`

```
-o, --output        Output path                 [default: ./outbox-config.json]
```

**Config file example:**

```json
{
  "schemaPath": "./prisma/schema.prisma",
  "modelName": "OutboxRecord",
  "tableName": "outbox",
  "generateMigration": true,
  "migrationName": "add_outbox_table",
  "customFields": {
    "tenantId": "String?",
    "version": "Int @default(1)"
  }
}
```

### `outbox setup replication`

```
-h, --host       PostgreSQL host               [default: localhost]
-p, --port       PostgreSQL port               [default: 5432]
-u, --user       PostgreSQL user               [required]
-P, --password   PostgreSQL password           [or set PGPASSWORD env var]
-d, --database   PostgreSQL database           [required]
-s, --slot-name  Replication slot name         [required]
```

### Manual SQL alternative

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

## Configuration

Required environment variables:

- `DATABASE_URL` — PostgreSQL connection string (logical replication must be enabled)
- `REPLICATION_SLOT_NAME` — Name of the PostgreSQL replication slot

NATS configuration:

- `NATS_SERVERS` — NATS server URLs, comma-separated (default: `nats://localhost:4222`)
- `NATS_CONNECTION_NAME` — Connection name (default: `outbox-reader`)
- `NATS_USER`, `NATS_PASSWORD`, `NATS_TOKEN` — Authentication (optional)
- `NATS_MAX_RECONNECT_ATTEMPTS`, `NATS_RECONNECT_TIME_WAIT`, `NATS_TIMEOUT` — Connection tuning (optional)

See `.env.example` and `packages/core/src/config.ts` for all options.

## Testing

```bash
# Run all tests
bun run test

# Run tests for a specific package
cd packages/core && bun test
cd packages/cli && bun test

# Run a single test file
cd packages/core && bun test test/outbox-processor.test.ts
```
