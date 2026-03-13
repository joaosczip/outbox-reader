import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Pool, type PoolClient } from "pg";
import { PrismaAdapter, type PrismaTransactionClient } from "../../src/adapters/prisma-adapter";
import { OutboxStatus } from "../../src/models/outbox-status";

const TEST_DB_URL = "postgres://root:root@localhost:5433/ecomm-be";

let pool: Pool;
let adapter: PrismaAdapter;

function makePgPrisma(client: Pool | PoolClient): PrismaTransactionClient {
	return {
		async $executeRawUnsafe(query: string, ...values: unknown[]) {
			const result = await client.query(query, values);
			return result.rowCount ?? 0;
		},
	};
}

const event = {
	aggregateId: "order-1",
	aggregateType: "Order",
	eventType: "order.created",
	payload: { total: 100 },
};

beforeAll(async () => {
	pool = new Pool({ connectionString: TEST_DB_URL });

	await pool.query(`
    CREATE TABLE IF NOT EXISTS outbox (
      id UUID PRIMARY KEY,
      aggregate_id TEXT NOT NULL,
      aggregate_type TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL
    )
  `);
});

afterAll(async () => {
	await pool?.query("DROP TABLE IF EXISTS outbox");
	await pool?.end();
});

beforeEach(async () => {
	await pool.query("DELETE FROM outbox");
	adapter = new PrismaAdapter();
});

describe("PrismaAdapter", () => {
	it("returns a valid UUID", async () => {
		const id = await adapter.create(event, { underlying: makePgPrisma(pool) });
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	});

	it("persists aggregate fields", async () => {
		const id = await adapter.create(event, { underlying: makePgPrisma(pool) });

		const result = await pool.query("SELECT * FROM outbox WHERE id = $1", [id]);
		const row = result.rows[0];
		expect(row.aggregate_id).toBe(event.aggregateId);
		expect(row.aggregate_type).toBe(event.aggregateType);
		expect(row.event_type).toBe(event.eventType);
	});

	it("persists payload as JSONB", async () => {
		const id = await adapter.create(event, { underlying: makePgPrisma(pool) });

		const result = await pool.query("SELECT payload FROM outbox WHERE id = $1", [id]);
		expect(result.rows[0].payload).toEqual(event.payload);
	});

	it("sets initial status to PENDING and attempts to 0", async () => {
		const id = await adapter.create(event, { underlying: makePgPrisma(pool) });

		const result = await pool.query("SELECT status, attempts FROM outbox WHERE id = $1", [id]);
		const row = result.rows[0];
		expect(row.status).toBe(OutboxStatus.PENDING);
		expect(row.attempts).toBe(0);
	});

	it("commits insert when transaction is committed", async () => {
		const client = await pool.connect();
		await client.query("BEGIN");
		const pgAdapter = new PrismaAdapter();
		const id = await pgAdapter.create(event, { underlying: makePgPrisma(client) });
		await client.query("COMMIT");
		client.release();

		const result = await pool.query("SELECT * FROM outbox WHERE id = $1", [id]);
		expect(result.rows).toHaveLength(1);
	});

	it("rolls back insert when transaction is rolled back", async () => {
		const client = await pool.connect();
		await client.query("BEGIN");
		const pgAdapter = new PrismaAdapter();
		const id = await pgAdapter.create(event, { underlying: makePgPrisma(client) });
		await client.query("ROLLBACK");
		client.release();

		const result = await pool.query("SELECT * FROM outbox WHERE id = $1", [id]);
		expect(result.rows).toHaveLength(0);
	});
});
