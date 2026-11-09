import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { PrismaAdapter } from "../../src/adapters/prisma-adapter";
import { OutboxStatus } from "../../src/models/outbox-status";
import { type MockPrismaTransactionClient, UUID_V7, createPrismaTransactionMock, normalizeSql } from "../mocks/orm";

const event = {
	aggregateId: "order-1",
	aggregateType: "Order",
	eventType: "order.created",
	payload: { total: 100 },
};

describe("PrismaAdapter", () => {
	let tx: MockPrismaTransactionClient;
	let adapter: PrismaAdapter;

	beforeEach(() => {
		tx = createPrismaTransactionMock();
		adapter = new PrismaAdapter();
	});

	describe("without the Bun global (Node runtime)", () => {
		const bun = globalThis.Bun as unknown as Record<string, unknown>;
		let original: unknown;

		beforeEach(() => {
			original = bun.randomUUIDv7;
			bun.randomUUIDv7 = () => {
				throw new ReferenceError("Bun is not defined");
			};
		});

		afterEach(() => {
			bun.randomUUIDv7 = original;
		});

		it("still generates a uuidv7 id and inserts the record", async () => {
			const id = await adapter.create(event, { underlying: tx });

			expect(id).toMatch(UUID_V7);
			expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
			expect(tx.$executeRawUnsafe.mock.calls[0][1]).toBe(id);
		});
	});

	it("inserts a PENDING record into the default snake_case outbox table through the transaction", async () => {
		const id = await adapter.create(event, { underlying: tx });

		expect(id).toMatch(UUID_V7);
		expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
		const [sql, ...values] = tx.$executeRawUnsafe.mock.calls[0];
		expect(normalizeSql(sql)).toBe(
			"INSERT INTO outbox (id, aggregate_id, aggregate_type, event_type, payload, status, attempts, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())",
		);
		expect(values).toEqual([
			id,
			"order-1",
			"Order",
			"order.created",
			JSON.stringify({ total: 100 }),
			OutboxStatus.PENDING,
			0,
		]);
	});

	it("propagates database errors", async () => {
		tx.$executeRawUnsafe.mockImplementation(async () => {
			throw new Error("relation does not exist");
		});

		await expect(adapter.create(event, { underlying: tx })).rejects.toThrow("relation does not exist");
	});
});
