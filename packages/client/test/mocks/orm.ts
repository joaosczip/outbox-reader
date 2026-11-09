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
