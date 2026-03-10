# Outbox Reader

A service that implements the [Transactional Outbox Pattern](https://microservices.io/patterns/data/transactional-outbox.html) to reliably publish database changes to NATS JetStream.

## Overview

Outbox Reader captures database changes via PostgreSQL's logical replication and publishes them to a NATS JetStream. It ensures that events are reliably delivered even in case of failures through a robust retry mechanism and transaction handling.

## Monorepo Structure

This repository is a Bun workspace monorepo with two independent packages:

| Package | Name | Description |
|---------|------|-------------|
| `packages/core` | `@outbox-reader/core` | Runtime service — WAL replication, event processing, NATS publishing, DB repository, cronjobs |
| `packages/cli` | `@outbox-reader/cli` | Developer tooling — Prisma schema generator and CLI for setting up the outbox table |

The CLI has no dependency on core and can be used standalone.

## Features

- PostgreSQL logical replication integration using `pg-logical-replication` and Wal2Json
- Reliable event publishing to NATS JetStream
- Configurable retry with exponential backoff
- Transactional guarantees for event processing
- Support for reprocessing failed events
- Monitoring of pending events

## Prerequisites

- Bun v1.2.0 or later
- PostgreSQL with logical replication enabled
- NATS server with JetStream enabled

## Installation

TBD

## Usage

### Requirements and configuration

Before start, you must have the following tools configured on your machine:

- NATS Server (^2.9.0)
- PostgreSQL database (^17.4.0)

In the case you don't have it, you may use the `docker-compose.yml` from this repository to start both services:

```sh
$ docker compose up -d
```

Once the tools are up and running, create a `.env` file based on the `.env.example` and fill it with the from the services you created.

```sh
$ cp .env.example .env
```

### Create the outbox table within your database

#### Option 1: Using Prisma (Recommended)

If you're using Prisma in your application, you can automatically generate the outbox schema and migration:

```bash
# Generate the outbox schema and migration with default settings
npx outbox-schema

# Or use custom configuration
npx outbox-schema --schema-path ./database/schema.prisma --model-name OutboxEvent

# Generate a configuration file first
npx outbox-schema generate-config
# Then use it
npx outbox-schema --config ./outbox-config.json

# Generate config with custom output path
npx outbox-schema generate-config --output ./my-custom-config.json
```

**Configuration Options:**

- `--schema-path, -s`: Path to your schema.prisma file (default: `./prisma/schema.prisma`)
- `--model-name, -m`: Name of the outbox model (default: `OutboxRecord`)
- `--table-name, -t`: Database table name (default: `outbox`)
- `--migration-name`: Migration name (default: `add_outbox_table`)
- `--config, -c`: Path to configuration file
- `--skip-migration`: Generate schema without migration

**Commands:**

- `generate-config`: Create a sample configuration file
    - `--output, -o`: Output path for the config file (default: `./outbox-config.json`)

**Configuration File Example:**

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

#### Option 2: Manual SQL Table Creation

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

### Configuration

The outbox reader uses environment variables for configuration. Copy the `.env.example` file and adjust the values:

```bash
cp .env.example .env
```

#### Required Configuration

- `DATABASE_URL`: PostgreSQL connection string with replication enabled
- `REPLICATION_SLOT_NAME`: Name of the PostgreSQL replication slot

#### NATS Configuration

The following environment variables configure the NATS connection:

- `NATS_SERVERS`: NATS server URLs (comma-separated for multiple servers)
    - Default: `nats://localhost:4222`
    - Example: `nats://server1:4222,nats://server2:4222`
- `NATS_CONNECTION_NAME`: Connection name for identification in server logs
    - Default: `outbox-reader`

**Optional NATS Settings:**

- `NATS_USER`: Username for authentication
- `NATS_PASSWORD`: Password for authentication
- `NATS_TOKEN`: Token for authentication
- `NATS_MAX_RECONNECT_ATTEMPTS`: Maximum reconnection attempts (-1 for unlimited)
- `NATS_RECONNECT_TIME_WAIT`: Time between reconnection attempts in milliseconds
- `NATS_TIMEOUT`: Connection timeout in milliseconds
- `NATS_VERBOSE`: Enable verbose logging (true/false)
- `NATS_PEDANTIC`: Enable pedantic mode (true/false)

### Start the service

```bash
bun run start
```

### Creating outbox entries

Insert records into your outbox table with the necessary event data:

```sql
INSERT INTO outbox (id, event_type, payload, aggregate_type, aggregate_id)
VALUES ('my_unique_id', 'user_created', '{"id": 123, "name": "John Doe"}'::jsonb, 'user', '123');
```

The outbox reader will automatically detect these changes and publish them to the configured NATS JetStream.

## Architecture

Outbox Reader implements the **Transactional Outbox Pattern**: instead of publishing domain events directly to a message broker (which can fail and leave the system in an inconsistent state), services write events into an `outbox` table in the same database transaction as the business operation. Outbox Reader then reads those records and reliably forwards them to NATS JetStream.

### How it works

The core pipeline is driven by **PostgreSQL logical replication**. Outbox Reader subscribes to a replication slot and receives WAL (Write-Ahead Log) events decoded by the `wal2json` plugin every time a row is inserted into the `outbox` table — without polling.

```
INSERT into outbox
        │
        ▼
┌───────────────┐   WAL / wal2json   ┌─────────────────────┐
│  PostgreSQL   │ ─────────────────> │  ReplicationService │
│  (outbox tbl) │                    │  (replication.ts)   │
└───────────────┘                    └──────────┬──────────┘
                                                │ onChange
                                                ▼
                                     ┌─────────────────────┐
                                     │   OutboxProcessor   │
                                     │ filterChanges()      │  ← keeps only INSERT on outbox
                                     │ processInserts()     │  ← confirmatory DB read, publish, update status
                                     └──────────┬──────────┘
                                      ┌─────────┴──────────┐
                                      ▼                     ▼
                             ┌────────────────┐   ┌────────────────────┐
                             │OutboxRepository│   │  NATSPublisher     │
                             │(outbox-repo.ts)│   │ (nats-publisher.ts)│
                             └────────────────┘   └────────────────────┘
                                                           │
                                                           ▼
                                                  ┌────────────────┐
                                                  │ NATS JetStream │
                                                  │ (consumers)    │
                                                  └────────────────┘
```

### Step-by-step flow

1. **WAL capture** — `startReplication()` opens a logical replication connection to PostgreSQL and subscribes to the configured replication slot. `wal2json` decodes each committed WAL record into a structured JSON change event.

2. **Filtering** — `OutboxProcessor.filterChanges()` discards any non-INSERT or non-outbox changes and maps database column names to camelCase `OutboxRecord` fields.

3. **Confirmatory read** — `OutboxProcessor.processInserts()` queries the database for the record by ID, confirming it's still `PENDING` or `FAILED` and hasn't exceeded the maximum retry count. This prevents duplicate processing if two instances are running.

4. **Publish** — `NATSPublisher.publish()` sends the event to JetStream using `record.eventType` as the subject and `record.aggregateId` as the deduplication message ID. The connection is established lazily on the first publish call.

5. **Status update** — On success, the record is marked `PROCESSED` and the NATS stream sequence number is stored alongside it. On failure (after retries), it's marked `FAILED` and the attempt counter is incremented.

### Status transitions

```
PENDING ──► PROCESSED   (publish succeeded)
PENDING ──► FAILED      (publish failed after all retries)
FAILED  ──► PENDING     (cronjob re-inserts the record, triggering a new WAL event)
```

### Fault tolerance

Both the NATS publish and the subsequent database status update are wrapped in independent exponential backoff with full jitter:

| Operation       | Max attempts | Starting delay | Max delay |
|-----------------|:------------:|:--------------:|:---------:|
| NATS publish    | 10           | 1 s            | 10 s      |
| DB status write | 10           | 300 ms         | 5 s       |

Failed events can be automatically reprocessed by the `reprocess-failed-events` cronjob, which deletes them and re-inserts them as `PENDING` inside a single transaction — causing the WAL stream to re-trigger the full pipeline.

## Monitoring

TBD

## Testing

```bash
# Run all tests across both packages
bun run test

# Run tests for a specific package
cd packages/core && bun test
cd packages/cli && bun test

# Run a single test file
cd packages/core && bun test test/outbox-processor.test.ts
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Roadmap

This project is under development and constantly improving, check our [ROADMAP](./ROADMAP.md) to see the next features and enhancements.
