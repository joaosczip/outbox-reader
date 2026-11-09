import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	SequelizeAdapter,
	type SequelizeAdapterOptions,
	type SequelizeTransaction,
} from "../../src/adapters/sequelize-adapter";
import { OutboxStatus } from "../../src/models/outbox-status";
import {
	INVALID_OPTIONS,
	type MockSequelize,
	NAMING_CASES,
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

	it("inserts a PENDING record with bind values within the forwarded transaction", async () => {
		const id = await adapter.create(event, { underlying: tx });

		expect(id).toMatch(UUID_V7);
		expect(sequelize.query).toHaveBeenCalledTimes(1);
		const [sql, options] = sequelize.query.mock.calls[0];
		expect(normalizeSql(sql)).toBe(NAMING_CASES[0].sql);
		expect(options).toEqual({
			bind: [id, "order-1", "Order", "order.created", JSON.stringify({ total: 100 }), OutboxStatus.PENDING, 0],
			transaction: tx,
		});
		expect(options?.transaction).toBe(tx);
	});

	it("uses the event id when provided instead of generating one", async () => {
		const providedId = "0190f0e0-1234-7abc-8def-0123456789ab";

		const id = await adapter.create({ ...event, id: providedId }, { underlying: tx });

		expect(id).toBe(providedId);
		expect((sequelize.query.mock.calls[0][1]?.bind as unknown[])[0]).toBe(providedId);
	});

	it("validates the event before querying the database", async () => {
		await expect(adapter.create({ ...event, aggregateId: "  " }, { underlying: tx })).rejects.toThrow(
			/CreateOutboxEvent\.aggregateId must be a non-empty string/,
		);
		expect(sequelize.query).not.toHaveBeenCalled();
	});

	describe("table and column naming", () => {
		it.each(NAMING_CASES.map((c) => [c.title, c] as const))(
			"builds the INSERT for %s",
			async (_title, testCase) => {
				const namedAdapter = new SequelizeAdapter(
					sequelize,
					testCase.options as SequelizeAdapterOptions | undefined,
				);

				const id = await namedAdapter.create(event, { underlying: tx });

				const [sql, options] = sequelize.query.mock.calls[0];
				expect(normalizeSql(sql)).toBe(testCase.sql);
				expect((options?.bind as unknown[])[0]).toBe(id);
				expect(options?.transaction).toBe(tx);
			},
		);

		it.each(INVALID_OPTIONS.map((c) => [JSON.stringify(c.options), c] as const))(
			"rejects invalid options %s at construction",
			(_title, testCase) => {
				expect(
					() => new SequelizeAdapter(sequelize, testCase.options as unknown as SequelizeAdapterOptions),
				).toThrow(testCase.error);
			},
		);
	});

	it("propagates database errors", async () => {
		sequelize.query.mockImplementation(async () => {
			throw new Error("relation does not exist");
		});

		await expect(adapter.create(event, { underlying: tx })).rejects.toThrow("relation does not exist");
	});
});
