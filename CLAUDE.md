# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start the service (with hot reload)
bun run start

# Run tests
bun test

# Run a single test file
bun test test/outbox-processor.test.ts

# Build TypeScript
bun run build

# Lint
bun run lint

# Cronjobs (run manually or on a schedule)
bun run reprocess-failed-events
bun run check-pending-events

# CLI tool for Prisma schema generation
bun run schema:generate
bunx outbox-schema [options]

# Docker (PostgreSQL + NATS)
docker compose up -d
```

## Architecture

This is a **Transactional Outbox Pattern** service. It listens to PostgreSQL WAL (Write-Ahead Log) events via logical replication and publishes them to NATS JetStream. The main data flow:

```
PostgreSQL WAL → replication.ts → OutboxProcessor → NATSPublisher → NATS JetStream
                                         ↕
                                  OutboxRepository (pg Pool)
```

### Core Flow (`src/app.ts`)

1. `startReplication()` subscribes to a PostgreSQL logical replication slot using `pg-logical-replication` with the Wal2Json plugin.
2. On each WAL event, `OutboxProcessor.filterChanges()` filters for `INSERT` operations on the `outbox` table and maps DB columns to camelCase entity fields.
3. `OutboxProcessor.processInserts()` fetches the record from DB (to confirm it's still `PENDING`/`FAILED`), calls `publisher.publish()`, then marks it as `PROCESSED`.
4. On failure, it marks the record `FAILED` and increments the attempt counter.

### Key Classes

- **`OutboxProcessor`** (`src/outbox-processor.ts`): Central orchestrator. Filters WAL changes to outbox inserts, processes them, and delegates to repository and publisher. Both `filterChanges()` and `processInserts()` are separate to allow independent testing.
- **`OutboxRepository`** (`src/outbox-repository.ts`): All DB interactions via a `pg.Pool`. Uses `backOff` (exponential-backoff) for `markAsProcessed`/`markAsFailed` writes. Exposes `onTransaction()` for transactional cronjob operations (uses a `Proxy` to swap the pool client transparently).
- **`NATSPublisher`** (`src/nats-publisher.ts`): Lazy-connects to NATS on first publish. Implements the `Publisher` interface. Uses `backOff` for retries. Publishes using `record.eventType` as the subject and `record.aggregateId` as the dedup `msgID`.
- **`startReplication`** (`src/replication.ts`): Thin wrapper around `LogicalReplicationService`. Appends `?replication=database` to the connection string.

### Retry Pattern

All retry-capable operations accept a `RetryConfig` with `numOfAttempts`, `startingDelayInMs`, `maxDelayInMs`, and `jitter`. DB writes and NATS publishes are separately configurable (see `src/config.ts`).

### Cronjobs (`src/cronjobs/`)

- **`reprocess-failed-events.ts`**: Finds all `FAILED` records, deletes them, and re-inserts as `PENDING` in a single transaction (causing WAL events to re-trigger the replication flow).
- **`check-pending-events.ts`**: Monitors `PENDING` events older than a configurable window.

### Outbox Record Statuses

`PENDING` → `PROCESSED` (success) or `FAILED` (after publish error). Max attempts check prevents infinite retries.

### CLI / Library Usage

`src/lib.ts` exports all core components for programmatic use. The `outbox-schema` bin (`bin/outbox-schema.js`) wraps `src/cli/generate-schema.ts` to generate Prisma schema and migrations for the outbox table.

## Environment Variables

Required:
- `DATABASE_URL`: PostgreSQL connection string (logical replication must be enabled on the DB)
- `REPLICATION_SLOT_NAME`: Name of the PostgreSQL replication slot

See `.env.example` and `src/config.ts` for all NATS and optional variables.

## Test Structure

Tests live in `test/` with mocks in `test/mocks/`. The project uses Bun's built-in test runner. Tests are co-located by feature (`outbox-processor.test.ts`, `nats-publisher.test.ts`, `prisma-schema-generator.test.ts`).
