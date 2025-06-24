# Outbox Reader

A service that implements the [Transactional Outbox Pattern](https://microservices.io/patterns/data/transactional-outbox.html) to reliably publish database changes to NATS JetStream.

## Overview

Outbox Reader captures database changes via PostgreSQL's logical replication and publishes them to a NATS JetStream. It ensures that events are reliably delivered even in case of failures through a robust retry mechanism and transaction handling.

## Features

- PostgreSQL logical replication integration using `pg-logical-replication` and Wal2Json
- Reliable event publishing to NATS JetStream
- Configurable retry with exponential backoff
- Transactional guarantees for event processing
- Support for reprocessing failed events
- Monitoring of pending events

## Prerequisites

- Node.js v23.7.0 or later
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

### Start the service

```bash
npm run start
```

### Creating outbox entries

Insert records into your outbox table with the necessary event data:

```sql
INSERT INTO outbox (id, event_type, payload, aggregate_type, aggregate_id)
VALUES ('my_unique_id', 'user_created', '{"id": 123, "name": "John Doe"}'::jsonb, 'user', '123');
```

The outbox reader will automatically detect these changes and publish them to the configured NATS JetStream.

## Architecture

The Outbox Reader consists of the following components:

1. **PostgreSQL Replication Listener** - Captures database changes from the WAL log
2. **Event Processor** - Transforms database changes into domain events
3. **NATS Publisher** - Publishes events to NATS JetStream
4. **Retry Manager** - Handles failed events with exponential backoff

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  PostgreSQL │    │   Outbox    │    │    NATS     │    │   Service   │
│  Database   │───>│   Reader    │───>│  JetStream  │───>│  Consumers  │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
```

## Monitoring

TBD

## Testing

TBD

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Roadmap

This project is under development and constantly improving, check our [ROADMAP](./ROADMAP.md) to see the next features and enhancements.
