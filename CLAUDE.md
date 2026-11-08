# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Git Workflow (Mandatory)

- **Commits are allowed.** Group related changes into small, focused commits.
- **Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/)**: `<type>(<optional scope>): <description>`.
  - Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `build`, `ci`, `style`, `revert`.
  - Scope is the affected package or area (e.g. `core`, `cli`, `client`, `replication`).
  - Use the imperative mood, lowercase description, no trailing period (e.g. `fix(core): use record id as jetstream msgID`).
  - Breaking changes: add `!` after the type/scope and a `BREAKING CHANGE:` footer describing the migration.
- **Never add Claude as a co-author** in commit messages (no `Co-Authored-By: Claude` lines).

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
bun run purge-processed-events

# CLI tool for Prisma schema generation (via workspace root)
bun run schema:generate
# Or run directly inside the cli package
cd packages/cli && bun src/cli/generate-schema.ts [options]

# Docker (PostgreSQL + NATS)
docker compose up -d
```

## Project Structure

This is a **Bun workspace monorepo**. Always make changes in the specific package directory, never the root, unless explicitly asked.

```
outbox-reader/
├── packages/
│   ├── core/        (@outbox-reader/core)       — runtime service: WAL replication, NATS publishing, DB repository, cronjobs
│   ├── cli/         (@joaosczip/outy-cli)        — developer tooling: Prisma schema generator, outbox table CLI
│   └── client/      (@joaosczip/outy-client)     — ORM-agnostic client for writing outbox events transactionally
└── CLAUDE.md
```

Each package has its own `CLAUDE.md` with package-specific guidance.

## Monorepo Structure

This is a **Bun workspace monorepo** with three packages:

- **`packages/core`** (`@outbox-reader/core`): The runtime service — WAL replication, event processing, NATS publishing, DB repository, cronjobs.
- **`packages/cli`** (`@joaosczip/outy-cli`): Developer tooling — Prisma schema generator and CLI for creating the outbox table. Does **not** depend on core.
- **`packages/client`** (`@joaosczip/outy-client`): ORM-agnostic client library for writing outbox events transactionally. Supports Prisma and Sequelize adapters. Does **not** depend on core.

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
3. `OutboxProcessor.processInserts()` fetches the record from DB (to confirm it's still `PENDING`/`FAILED`). An older `PENDING` or `FAILED` sibling of the same aggregate blocks the publish (`blocked`); otherwise it calls `publisher.publish()` and marks the record `PROCESSED`.
4. On a publish failure the head is handed to the `RetryQueue`. Later siblings of that aggregate stay `PENDING` until the head is published or marked `DEAD`.

The WAL `onChange` callback is built by `createWalChangeHandler()` (`packages/core/src/wal-change-handler.ts`): filter → one batched `findUnprocessedByIds` prefetch → `runOrderedByKey` keyed by `aggregateId` (sequential per aggregate, parallel across aggregates, concurrency = `DB_POOL_SIZE`), with a per-aggregate promise chain shared with the `RetryQueue`. A publish failure enqueues that head only and does not reject; batch-level failures (e.g. the prefetch query) reject so the LSN is not acked. Order inside one aggregate is `(created_at, id)`. `DEAD` does not block successors. The predecessor check is not a cross-process lock: the live service and `check-pending-events` can both pass it (TOCTOU). See `packages/core/CLAUDE.md`.

Because Postgres acks are cumulative, `app.ts` treats replication `onError` as fatal: it runs the graceful shutdown and exits with code 1 so the restarted process resumes from the last confirmed LSN. Startup failures also exit 1. The health server exposes `/live`, and `/ready` (alias `/health`) with readiness checks `replication`, `publisher` (`isConnected?.()`) and `database` (`SELECT 1`).

`DATABASE_URL` must be a plain URL (no `?replication=database`): `replication.ts` adds it for the replication connection, and the same URL feeds the regular `pg.Pool`.

### Key Classes

- **`OutboxProcessor`** (`packages/core/src/outbox-processor.ts`): Central orchestrator. Filters WAL changes to outbox inserts, processes them, and delegates to repository and publisher. Both `filterChanges()` and `processInserts()` are separate to allow independent testing.
- **`OutboxRepository`** (`packages/core/src/outbox-repository.ts`): All DB interactions via a `pg.Pool`. Uses `backOff` (exponential-backoff) for `markAsProcessed`/`markAsFailed` writes. Exposes `onTransaction()` for transactional cronjob operations (uses a `Proxy` to swap the pool client transparently).
- **`NATSPublisher`** (`packages/core/src/nats-publisher.ts`): Lazy-connects to NATS on first publish. Implements the `Publisher` interface. Uses `backOff` for retries. Publishes using `record.eventType` as the subject and `record.id` as the dedup `msgID` (unique per event, so retries of the same record are deduplicated but distinct events of one aggregate are not; a `duplicate` PubAck is logged as a warning).
- **`startReplication`** (`packages/core/src/replication.ts`): Thin wrapper around `LogicalReplicationService`. Sets `replication=database` on the connection string via `buildReplicationConnectionString()` (preserves existing query params). When given `tableName` (the physical name from `applyNamingToTableName`, wired by `app.ts`), it builds the Wal2Json plugin with `buildWal2JsonOptions()` — `add-tables '*.<table>'` (name escaped by `escapeWal2JsonTableName()`), `actions 'insert'`, `include-types 'off'` — so PostgreSQL streams only outbox INSERTs (requires wal2json >= 2.0 for `actions`); without `tableName` every change is streamed. Uses manual LSN acknowledgement: each LSN is acked only after `onChange` resolves; failures and service `error` events go to the optional `onError` callback.

### Retry Pattern

All retry-capable operations accept a `RetryConfig` with `numOfAttempts`, `startingDelayInMs`, `maxDelayInMs`, and `jitter`. DB writes and NATS publishes are separately configurable (see `packages/core/src/config.ts`).

### Cronjobs (`packages/core/src/cronjobs/`)

- **`reprocess-failed-events.ts`**: In batches, finds `FAILED` records, deletes them, and re-inserts as `PENDING` (causing WAL events to re-trigger the replication flow); exhausted ones are marked `DEAD`. Each batch is one transaction with set-based statements: `markManyAsDead` (single `UPDATE ... FROM unnest(...)`, per-row optimistic lock on `attempts`) and `requeueFailed` (single `DELETE ... RETURNING` + `INSERT ... SELECT`, original `created_at` preserved, `requeued_at = NOW()`).
- **`check-pending-events.ts`**: Stale `PENDING` sweeper. In batches, finds `PENDING` records older than `PENDING_EVENTS_THRESHOLD_MINUTES` (default 10) — events the main service likely lost (crash, lost in-memory retry, WAL acked but not processed) — and runs each through `OutboxProcessor.processInserts()` (via `runOrderedByKey` keyed by `aggregateId`: sequential per aggregate, parallel across aggregates, concurrency = `DB_POOL_SIZE`) with the publisher from `publisher.yaml` (fresh DB read, so already-processed records are skipped). A failing record is marked `FAILED` (feeding `reprocess-failed-events`) and later siblings of that aggregate stay `PENDING`; other aggregates continue. Staleness requires both `created_at` and `requeued_at` (when set) to be older than the threshold. **At-least-once caveat:** NATS dedups by `record.id` only within the stream's duplicate window (default 2 min); if the original publish succeeded but marking `PROCESSED` failed, the republish creates a duplicate — consumers must be idempotent. The sweeper and the live service can also both pass the per-aggregate predecessor check.
- **`purge-processed-events.ts`**: Retention purge. Deletes `PROCESSED` records whose `processed_at` is older than `PROCESSED_RETENTION_DAYS` (default 7) in bounded batches (`OutboxRepository.deleteProcessedBefore`, `DELETE ... WHERE id IN (SELECT ... LIMIT n)`, 1000 rows per batch) until a batch comes back short, keeping each statement's locks/WAL short. `DEAD` records are kept by default (they need human inspection) and purged only when `DEAD_RETENTION_DAYS` is set; their age is `COALESCE(processed_at, created_at)` since DEAD rows usually have no `processed_at`. `PENDING`/`FAILED` are never deleted (the repository rejects those statuses). Cutoffs use the DB clock.

### Outbox Record Statuses

`PENDING` → `PROCESSED` (success) | `FAILED` (after publish error) → `DEAD` (terminal).

A record whose `attempts` reach `MAX_OUTBOX_ATTEMPTS` is marked `DEAD` (by `OutboxProcessor`, `RetryQueue` when the final retry consumes the last attempt, or the `reprocess-failed-events` cron) and is never retried or re-inserted. Status writes use an optimistic lock on `attempts`; a miss (`false` return) is logged as a warning and counted in the `outbox.records.optimistic_lock_miss` metric.

### CLI / Library Usage

`packages/core/src/lib.ts` exports all core components for programmatic use. `packages/cli/src/index.ts` is the public API entry for the CLI package, exporting `PrismaSchemaGenerator` and the schema config types. The `outbox-schema` bin (`packages/cli/bin/outbox-schema.js`) wraps `packages/cli/src/cli/generate-schema.ts` to generate Prisma schema and migrations for the outbox table.

## Environment Variables

Required:
- `DATABASE_URL`: PostgreSQL connection string (logical replication must be enabled on the DB)
- `REPLICATION_SLOT_NAME`: Name of the PostgreSQL replication slot (replication service only; cronjobs do not need it — they use `loadCronConfig()`)

Optional (validated when read; invalid values throw a descriptive error instead of silently becoming `NaN`):
- `DB_POOL_SIZE`: integer >= 1, default `10`
- `MAX_OUTBOX_ATTEMPTS`: integer >= 1, default `5`
- `COLUMN_NAMING`: `snake_case` | `camelCase` | `PascalCase`, default `snake_case`
- `TABLE_NAME`: default `outbox`
- `PUBLISHER_CONFIG_PATH`: default `./publisher.yaml` (validated per provider by `loadPublisherConfig`)
- `PENDING_EVENTS_THRESHOLD_MINUTES` (cronjobs): integer >= 1, default `10`
- `PROCESSED_RETENTION_DAYS` (cronjobs): integer >= 1, default `7` — `purge-processed-events` deletes `PROCESSED` records older than this
- `DEAD_RETENTION_DAYS` (cronjobs): integer >= 1, unset = never purge `DEAD` records (opt-in)

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

## Implementation Principles

- Before designing a custom solution, check if the library/framework already has a built-in option. Prefer simple configuration over custom code.

## Bugfix Workflow (Mandatory)

1. Investigate the reported bug and identify the likely root cause and affected flow.
2. Write a regression test that reproduces the bug and proves the incorrect behavior exists.
3. Run the regression test and confirm it **fails** before applying the fix.
4. Implement the code fix.
5. Run the same regression test again and confirm it **passes** after the fix.
