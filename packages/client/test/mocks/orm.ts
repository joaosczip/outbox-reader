import { type Mock, mock } from "bun:test";
import type { PrismaTransactionClient } from "../../src/adapters/prisma-adapter";
import type { SequelizeLike, SequelizeTransaction } from "../../src/adapters/sequelize-adapter";

export type MockPrismaTransactionClient = PrismaTransactionClient & {
	$executeRawUnsafe: Mock<(query: string, ...values: unknown[]) => Promise<number>>;
};

export function createPrismaTransactionMock(): MockPrismaTransactionClient {
	return { $executeRawUnsafe: mock(async (_query: string, ..._values: unknown[]) => 1) };
}

export type MockSequelize = SequelizeLike & {
	query: Mock<(sql: string, options?: Record<string, unknown>) => Promise<unknown>>;
};

export function createSequelizeMock(): MockSequelize {
	return { query: mock(async (_sql: string, _options?: Record<string, unknown>) => [[], 1] as unknown) };
}

export function createSequelizeTransactionMock(): SequelizeTransaction {
	return { LOCK: {} };
}

/** Collapses whitespace so SQL can be compared regardless of formatting. */
export const normalizeSql = (sql: string): string => sql.replace(/\s+/g, " ").trim();

export const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const VALUES_CLAUSE = "VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())";

/** Expected INSERT statements per adapter options, written out literally (not derived from src). */
export const NAMING_CASES = [
	{
		title: "defaults (outbox / snake_case)",
		options: undefined,
		sql: `INSERT INTO "outbox" ("id", "aggregate_id", "aggregate_type", "event_type", "payload", "status", "attempts", "created_at") ${VALUES_CLAUSE}`,
	},
	{
		title: "custom snake_case table",
		options: { tableName: "Outbox_Events", columnNaming: "snake_case" },
		sql: `INSERT INTO "outbox_events" ("id", "aggregate_id", "aggregate_type", "event_type", "payload", "status", "attempts", "created_at") ${VALUES_CLAUSE}`,
	},
	{
		title: "camelCase",
		options: { tableName: "outbox_events", columnNaming: "camelCase" },
		sql: `INSERT INTO "outboxEvents" ("id", "aggregateId", "aggregateType", "eventType", "payload", "status", "attempts", "createdAt") ${VALUES_CLAUSE}`,
	},
	{
		title: "PascalCase with default table",
		options: { columnNaming: "PascalCase" },
		sql: `INSERT INTO "Outbox" ("id", "AggregateId", "AggregateType", "EventType", "payload", "status", "attempts", "CreatedAt") ${VALUES_CLAUSE}`,
	},
	{
		title: "table name containing a double quote",
		options: { tableName: 'out"box' },
		sql: `INSERT INTO "out""box" ("id", "aggregate_id", "aggregate_type", "event_type", "payload", "status", "attempts", "created_at") ${VALUES_CLAUSE}`,
	},
] as const;

export const INVALID_OPTIONS = [
	{
		options: { columnNaming: "kebab-case" },
		error: /columnNaming must be one of: snake_case, camelCase, PascalCase/,
	},
	{ options: { tableName: "" }, error: /tableName must be a non-empty string/ },
	{ options: { tableName: "   " }, error: /tableName must be a non-empty string/ },
] as const;
