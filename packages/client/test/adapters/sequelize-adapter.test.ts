import { describe, expect, it, mock } from "bun:test";
import { SequelizeAdapter, type SequelizeLike, type SequelizeTransaction } from "../../src/adapters/sequelize-adapter";
import { OutboxStatus } from "../../src/models/outbox-status";
import type { Transaction } from "../../src/types/transaction";

describe("SequelizeAdapter", () => {
	const mockSequelize: SequelizeLike = {
		query: mock(() => Promise.resolve(undefined)),
	};

	const mockTx: SequelizeTransaction = {};

	const transaction: Transaction<SequelizeTransaction> = {
		underlying: mockTx,
	};

	const event = {
		aggregateId: "order-1",
		aggregateType: "Order",
		eventType: "order.created",
		payload: { total: 100 },
	};

	it("should insert into outbox and return generated id", async () => {
		const adapter = new SequelizeAdapter(mockSequelize);

		const id = await adapter.create(event, transaction);

		expect(id).toBeString();
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	it("should call sequelize.query with correct SQL and bind parameters", async () => {
		const adapter = new SequelizeAdapter(mockSequelize);

		const id = await adapter.create(event, transaction);

		expect(mockSequelize.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO outbox"), {
			bind: [
				id,
				event.aggregateId,
				event.aggregateType,
				event.eventType,
				JSON.stringify(event.payload),
				OutboxStatus.PENDING,
				0,
			],
			transaction: mockTx,
		});
	});

	it("should pass the transaction to the query options", async () => {
		const adapter = new SequelizeAdapter(mockSequelize);

		await adapter.create(event, transaction);

		const callArgs = (mockSequelize.query as ReturnType<typeof mock>).mock.calls.at(-1);
		const options = callArgs?.[1] as Record<string, unknown>;
		expect(options.transaction).toBe(mockTx);
	});

	it("should stringify the payload", async () => {
		const adapter = new SequelizeAdapter(mockSequelize);

		await adapter.create(event, transaction);

		const callArgs = (mockSequelize.query as ReturnType<typeof mock>).mock.calls.at(-1);
		const options = callArgs?.[1] as { bind: unknown[] };
		expect(options.bind[4]).toBe(JSON.stringify(event.payload));
	});
});
