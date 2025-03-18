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

```bash
# Clone the repository
git clone https://github.com/yourusername/outbox-reader.git
cd outbox-reader

# Install dependencies
npm install

# Setup database schema
npm run db:generate
npm run db:migrate:dev
```

## Configuration

Create a `.env` file in the project root:

```bash
# PostgreSQL connection
DATABASE_URL=postgresql://username:password@localhost:5432/mydatabase

# NATS connection
NATS_URL=nats://localhost:4222
NATS_STREAM=outbox-events

# Replication configuration
REPLICATION_SLOT=outbox_slot
PUBLICATION_NAME=outbox_publication
OUTBOX_TABLE=outbox

# Processing configuration
BATCH_SIZE=100
RETRY_MAX_ATTEMPTS=10
RETRY_INITIAL_DELAY_MS=100
```

## Usage

### Starting the service

```bash
npm run start
```

For development with automatic restart:

```bash
npm run dev
```

### Creating outbox entries

Insert records into your outbox table with the necessary event data:

```sql
INSERT INTO outbox (event_type, payload, aggregate_type, aggregate_id)
VALUES ('user_created', '{"id": 123, "name": "John Doe"}', 'user', '123');
```

The outbox reader will automatically detect these changes and publish them to the configured NATS JetStream.

## Architecture

The Outbox Reader consists of the following components:

1. **PostgreSQL Replication Listener** - Captures database changes from the WAL log
2. **Event Processor** - Transforms database changes into domain events
3. **NATS Publisher** - Publishes events to NATS JetStream
4. **Retry Manager** - Handles failed events with exponential backoff
5. **Health Monitor** - Reports on system health and pending events

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  PostgreSQL │    │   Outbox    │    │    NATS     │    │   Service   │
│  Database   │───>│   Reader    │───>│  JetStream  │───>│  Consumers  │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
```

## Monitoring

The service exposes metrics on port 3000 by default:

- `/health` - Health check endpoint
- `/metrics` - Prometheus metrics
- `/pending` - Count of pending events

## Testing

```bash
# Run unit tests
npm run test

# Run integration tests
npm run test:integration
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

Distributed under the MIT License. See `LICENSE` for more information.
