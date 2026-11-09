import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { PrismaAdapter, type PrismaAdapterOptions } from "../../src/adapters/prisma-adapter";
import { OutboxStatus } from "../../src/models/outbox-status";
import {
	INVALID_OPTIONS,
	type MockPrismaTransactionClient,
	NAMING_CASES,
	UUID_V7,
	createPrismaTransactionMock,
	normalizeSql,
} from "../mocks/orm";

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

	it("inserts a PENDING record with the event values through the transaction client", async () => {
		const id = await adapter.create(event, { underlying: tx });

		expect(id).toMatch(UUID_V7);
		expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
		const [sql, ...values] = tx.$executeRawUnsafe.mock.calls[0];
		expect(normalizeSql(sql)).toBe(NAMING_CASES[0].sql);
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

	it("uses the event id when provided instead of generating one", async () => {
		const providedId = "0190f0e0-1234-7abc-8def-0123456789ab";

		const id = await adapter.create({ ...event, id: providedId }, { underlying: tx });

		expect(id).toBe(providedId);
		expect(tx.$executeRawUnsafe.mock.calls[0][1]).toBe(providedId);
	});

	it("validates the event before querying the database", async () => {
		await expect(adapter.create({ ...event, eventType: "" }, { underlying: tx })).rejects.toThrow(
			/CreateOutboxEvent\.eventType must be a non-empty string/,
		);
		expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
	});

	it("generates a distinct id per call", async () => {
		const first = await adapter.create(event, { underlying: tx });
		const second = await adapter.create(event, { underlying: tx });

		expect(first).not.toBe(second);
	});

	describe("table and column naming", () => {
		it.each(NAMING_CASES.map((c) => [c.title, c] as const))(
			"builds the INSERT for %s",
			async (_title, testCase) => {
				const namedAdapter = new PrismaAdapter(testCase.options as PrismaAdapterOptions | undefined);

				const id = await namedAdapter.create(event, { underlying: tx });

				const [sql, ...values] = tx.$executeRawUnsafe.mock.calls[0];
				expect(normalizeSql(sql)).toBe(testCase.sql);
				expect(values[0]).toBe(id);
			},
		);

		it.each(INVALID_OPTIONS.map((c) => [JSON.stringify(c.options), c] as const))(
			"rejects invalid options %s at construction",
			(_title, testCase) => {
				expect(() => new PrismaAdapter(testCase.options as unknown as PrismaAdapterOptions)).toThrow(
					testCase.error,
				);
			},
		);
	});

	it("propagates database errors", async () => {
		tx.$executeRawUnsafe.mockImplementation(async () => {
			throw new Error("relation does not exist");
		});

		await expect(adapter.create(event, { underlying: tx })).rejects.toThrow("relation does not exist");
	});
});
