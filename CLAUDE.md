# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start the service (with hot reload)
bun run start

# Run tests (all packages)
bun run test

# Run tests for a single package
cd packages/core && bun test
cd packages/cli && bun test

# Run a single test file
cd packages/core && bun test test/outbox-processor.test.ts

# Build TypeScript
bun run build

# Lint
bun run lint

# Cronjobs (run manually or on a schedule)
bun run reprocess-failed-events
bun run check-pending-events

# CLI tool for Prisma schema generation (via workspace root)
bun run schema:generate
# Or run directly inside the cli package
cd packages/cli && bun src/cli/generate-schema.ts [options]

# Docker (PostgreSQL + NATS)
docker compose up -d
```

## Monorepo Structure

This is a **Bun workspace monorepo** with two packages:

- **`packages/core`** (`@outbox-reader/core`): The runtime service — WAL replication, event processing, NATS publishing, DB repository, cronjobs.
- **`packages/cli`** (`@outy/cli`): Developer tooling — Prisma schema generator and CLI for creating the outbox table. Does **not** depend on core.

## Architecture

This is a **Transactional Outbox Pattern** service. It listens to PostgreSQL WAL (Write-Ahead Log) events via logical replication and publishes them to NATS JetStream. The main data flow:

```
PostgreSQL WAL → replication.ts → OutboxProcessor → NATSPublisher → NATS JetStream
                                         ↕
                                  OutboxRepository (pg Pool)
```

### Core Flow (`packages/core/src/app.ts`)

1. `startReplication()` subscribes to a PostgreSQL logical replication slot using `pg-logical-replication` with the Wal2Json plugin.
2. On each WAL event, `OutboxProcessor.filterChanges()` filters for `INSERT` operations on the `outbox` table and maps DB columns to camelCase entity fields.
3. `OutboxProcessor.processInserts()` fetches the record from DB (to confirm it's still `PENDING`/`FAILED`), calls `publisher.publish()`, then marks it as `PROCESSED`.
4. On failure, it marks the record `FAILED` and increments the attempt counter.

### Key Classes

- **`OutboxProcessor`** (`packages/core/src/outbox-processor.ts`): Central orchestrator. Filters WAL changes to outbox inserts, processes them, and delegates to repository and publisher. Both `filterChanges()` and `processInserts()` are separate to allow independent testing.
- **`OutboxRepository`** (`packages/core/src/outbox-repository.ts`): All DB interactions via a `pg.Pool`. Uses `backOff` (exponential-backoff) for `markAsProcessed`/`markAsFailed` writes. Exposes `onTransaction()` for transactional cronjob operations (uses a `Proxy` to swap the pool client transparently).
- **`NATSPublisher`** (`packages/core/src/nats-publisher.ts`): Lazy-connects to NATS on first publish. Implements the `Publisher` interface. Uses `backOff` for retries. Publishes using `record.eventType` as the subject and `record.aggregateId` as the dedup `msgID`.
- **`startReplication`** (`packages/core/src/replication.ts`): Thin wrapper around `LogicalReplicationService`. Appends `?replication=database` to the connection string.

### Retry Pattern

All retry-capable operations accept a `RetryConfig` with `numOfAttempts`, `startingDelayInMs`, `maxDelayInMs`, and `jitter`. DB writes and NATS publishes are separately configurable (see `packages/core/src/config.ts`).

### Cronjobs (`packages/core/src/cronjobs/`)

- **`reprocess-failed-events.ts`**: Finds all `FAILED` records, deletes them, and re-inserts as `PENDING` in a single transaction (causing WAL events to re-trigger the replication flow).
- **`check-pending-events.ts`**: Monitors `PENDING` events older than a configurable window.

### Outbox Record Statuses

`PENDING` → `PROCESSED` (success) or `FAILED` (after publish error). Max attempts check prevents infinite retries.

### CLI / Library Usage

`packages/core/src/lib.ts` exports all core components for programmatic use. `packages/cli/src/index.ts` is the public API entry for the CLI package, exporting `PrismaSchemaGenerator` and the schema config types. The `outbox-schema` bin (`packages/cli/bin/outbox-schema.js`) wraps `packages/cli/src/cli/generate-schema.ts` to generate Prisma schema and migrations for the outbox table.

## Environment Variables

Required:
- `DATABASE_URL`: PostgreSQL connection string (logical replication must be enabled on the DB)
- `REPLICATION_SLOT_NAME`: Name of the PostgreSQL replication slot

See `.env.example` and `packages/core/src/config.ts` for all NATS and optional variables.

## Test Structure

Tests live in `test/` within each package (`packages/core/test/`, `packages/cli/test/`). The project uses Bun's built-in test runner. Core mocks are in `packages/core/test/mocks/`.

## Arranging Tests (Mandatory)

- Never instantiate classes under test directly with their full dependency list — use mock objects or factory helpers instead.
- Prefer testing through the public interface of a class, not its internal implementation details.
- Keep test setup in `beforeEach`/`beforeAll` blocks and tear down in `afterEach`/`afterAll`.

**Bad** — direct instantiation with casted mocks:

```ts
const processor = new OutboxProcessor(
  repository as never,
  publisher as never,
  {} as never,
);
```

**Good** — mock collaborators explicitly:

```ts
let processor: OutboxProcessor;

beforeEach(() => {
  const repository = mock<OutboxRepository>();
  const publisher = mock<Publisher>();
  processor = new OutboxProcessor(repository, publisher, config);
});
```

## Testing Expectations (Mandatory)

- Every bugfix or feature must include relevant tests.
- Run narrow tests first, then broaden:
  - Unit: `packages/core/test/*.test.ts`
  - Integration (if applicable): tests that exercise real DB/NATS via Testcontainers
- New or changed behavior must include assertions that cover the full expected outcome, not just the happy path.
- For critical flows, include at least one regression assertion.

## Coverage Quality (Mandatory)

- Good coverage is not defined by line-coverage percentage alone.
- Coverage is good when tests validate behavior end-to-end and **fail when that behavior breaks**.
- Prioritize coverage for critical flows: WAL event processing, status transitions (`PENDING` → `PROCESSED`/`FAILED`), retry logic, and cronjob operations.
- Prefer assertions that protect against regressions: inputs, outputs, side effects, persistence changes, and error paths.
- A smaller suite with strong behavioral assertions is better than a larger suite that only executes lines without validating outcomes.

## Bugfix Workflow (Mandatory)

1. Investigate the reported bug and identify the likely root cause and affected flow.
2. Write a regression test that reproduces the bug and proves the incorrect behavior exists.
3. Run the regression test and confirm it **fails** before applying the fix.
4. Implement the code fix.
5. Run the same regression test again and confirm it **passes** after the fix.
