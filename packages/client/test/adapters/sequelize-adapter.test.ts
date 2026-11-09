import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SequelizeAdapter, type SequelizeTransaction } from "../../src/adapters/sequelize-adapter";
import { OutboxStatus } from "../../src/models/outbox-status";
import {
	type MockSequelize,
	UUID_V7,
	createSequelizeMock,
	createSequelizeTransactionMock,
	normalizeSql,
} from "../mocks/orm";

const event = {
	aggregateId: "order-1",
	aggregateType: "Order",
	eventType: "order.created",
	payload: { total: 100 },
};

describe("SequelizeAdapter", () => {
	let sequelize: MockSequelize;
	let tx: SequelizeTransaction;
	let adapter: SequelizeAdapter;

	beforeEach(() => {
		sequelize = createSequelizeMock();
		tx = createSequelizeTransactionMock();
		adapter = new SequelizeAdapter(sequelize);
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
			expect(sequelize.query).toHaveBeenCalledTimes(1);
			expect((sequelize.query.mock.calls[0][1]?.bind as unknown[])[0]).toBe(id);
		});
	});

	it("inserts a PENDING record into the default snake_case outbox table within the transaction", async () => {
		const id = await adapter.create(event, { underlying: tx });

		expect(id).toMatch(UUID_V7);
		expect(sequelize.query).toHaveBeenCalledTimes(1);
		const [sql, options] = sequelize.query.mock.calls[0];
		expect(normalizeSql(sql)).toBe(
			"INSERT INTO outbox (id, aggregate_id, aggregate_type, event_type, payload, status, attempts, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())",
		);
		expect(options).toEqual({
			bind: [id, "order-1", "Order", "order.created", JSON.stringify({ total: 100 }), OutboxStatus.PENDING, 0],
			transaction: tx,
		});
		expect(options?.transaction).toBe(tx);
	});

	it("propagates database errors", async () => {
		sequelize.query.mockImplementation(async () => {
			throw new Error("relation does not exist");
		});

		await expect(adapter.create(event, { underlying: tx })).rejects.toThrow("relation does not exist");
	});
});
