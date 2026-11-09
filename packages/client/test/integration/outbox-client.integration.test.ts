import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Pool, type PoolClient } from "pg";
import { PrismaAdapter, type PrismaTransactionClient } from "../../src/adapters/prisma-adapter";
import { SequelizeAdapter, type SequelizeLike } from "../../src/adapters/sequelize-adapter";
import { OutboxStatus } from "../../src/models/outbox-status";
import { OutboxClient } from "../../src/outbox-client";
import type { OutboxAdapter } from "../../src/types/adapter";

/**
 * Integration tests against a real PostgreSQL database.
 * They are skipped unless DATABASE_URL points at a disposable database.
 */
const databaseUrl = process.env.DATABASE_URL;

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const event = {
	aggregateId: "order-1",
	aggregateType: "Order",
	eventType: "order.created",
	payload: { total: 100 },
};

function prismaLike(client: Pool | PoolClient): PrismaTransactionClient {
	return {
		async $executeRawUnsafe(query: string, ...values: unknown[]) {
			const result = await client.query(query, values);
			return result.rowCount ?? 0;
		},
	};
}

function sequelizeLike(): SequelizeLike {
	return {
		async query(sql: string, options?: Record<string, unknown>) {
			const client = options?.transaction as PoolClient;
			return client.query(sql, options?.bind as unknown[]);
		},
	};
}

type Case = {
	name: string;
	adapter: () => OutboxAdapter<unknown>;
	transaction: (client: PoolClient) => unknown;
};

const cases: Case[] = [
	{
		name: "PrismaAdapter",
		adapter: () => new PrismaAdapter() as OutboxAdapter<unknown>,
		transaction: (client) => prismaLike(client),
	},
	{
		name: "SequelizeAdapter",
		adapter: () => new SequelizeAdapter(sequelizeLike()) as OutboxAdapter<unknown>,
		transaction: (client) => client,
	},
];

describe.skipIf(!databaseUrl)("OutboxClient (integration)", () => {
	let pool: Pool;

	beforeAll(async () => {
		pool = new Pool({ connectionString: databaseUrl });
		await pool.query(`
			CREATE TABLE IF NOT EXISTS outbox (
				id UUID PRIMARY KEY,
				aggregate_id VARCHAR(50) NOT NULL,
				aggregate_type VARCHAR(50) NOT NULL,
				event_type VARCHAR(50) NOT NULL,
				payload JSONB NOT NULL,
				status TEXT NOT NULL DEFAULT 'PENDING',
				attempts INTEGER NOT NULL DEFAULT 0,
				created_at TIMESTAMP NOT NULL DEFAULT NOW(),
				processed_at TIMESTAMP,
				sequence_number BIGINT
			)
		`);
	});

	afterAll(async () => {
		await pool?.query("DROP TABLE IF EXISTS outbox");
		await pool?.end();
	});

	beforeEach(async () => {
		await pool.query("DELETE FROM outbox");
	});

	describe("camelCase naming", () => {
		beforeAll(async () => {
			await pool.query(`
				CREATE TABLE IF NOT EXISTS "outboxEvents" (
					"id" UUID PRIMARY KEY,
					"aggregateId" VARCHAR(50) NOT NULL,
					"aggregateType" VARCHAR(50) NOT NULL,
					"eventType" VARCHAR(50) NOT NULL,
					"payload" JSONB NOT NULL,
					"status" TEXT NOT NULL DEFAULT 'PENDING',
					"attempts" INTEGER NOT NULL DEFAULT 0,
					"createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
				)
			`);
		});

		afterAll(async () => {
			await pool.query('DROP TABLE IF EXISTS "outboxEvents"');
		});

		it("writes to the quoted camelCase table and columns", async () => {
			const outbox = new OutboxClient(
				new PrismaAdapter({ tableName: "outbox_events", columnNaming: "camelCase" }),
			);

			const id = await outbox.create(event, { underlying: prismaLike(pool) });

			const { rows } = await pool.query('SELECT * FROM "outboxEvents" WHERE "id" = $1', [id]);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ aggregateId: event.aggregateId, status: OutboxStatus.PENDING });
		});
	});

	for (const testCase of cases) {
		describe(testCase.name, () => {
			let outbox: OutboxClient<unknown>;
			let client: PoolClient;

			beforeEach(async () => {
				outbox = new OutboxClient(testCase.adapter());
				client = await pool.connect();
				await client.query("BEGIN");
			});

			afterEach(() => {
				client.release();
			});

			it("persists a PENDING record with the returned uuidv7 id when committed", async () => {
				const id = await outbox.create(event, { underlying: testCase.transaction(client) });
				await client.query("COMMIT");

				expect(id).toMatch(UUID_V7);
				const { rows } = await pool.query("SELECT * FROM outbox WHERE id = $1", [id]);
				expect(rows).toHaveLength(1);
				expect(rows[0]).toMatchObject({
					aggregate_id: event.aggregateId,
					aggregate_type: event.aggregateType,
					event_type: event.eventType,
					payload: event.payload,
					status: OutboxStatus.PENDING,
					attempts: 0,
				});
				expect(rows[0].created_at).toBeInstanceOf(Date);
			});

			it("discards the record when the transaction is rolled back", async () => {
				const id = await outbox.create(event, { underlying: testCase.transaction(client) });
				await client.query("ROLLBACK");

				const { rows } = await pool.query("SELECT * FROM outbox WHERE id = $1", [id]);
				expect(rows).toHaveLength(0);
			});
		});
	}
});
