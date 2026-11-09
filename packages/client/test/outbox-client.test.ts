import { type Mock, beforeEach, describe, expect, it, mock } from "bun:test";
import { PrismaAdapter } from "../src/adapters/prisma-adapter";
import { OutboxClient } from "../src/outbox-client";
import type { OutboxAdapter } from "../src/types/adapter";
import type { CreateOutboxEvent } from "../src/types/outbox-event";
import type { Transaction } from "../src/types/transaction";
import { type MockPrismaTransactionClient, UUID_V7, createPrismaTransactionMock } from "./mocks/orm";

type FakeTx = { query: () => void };

type MockAdapter = OutboxAdapter<FakeTx> & {
	create: Mock<(event: CreateOutboxEvent, transaction: Transaction<FakeTx>) => Promise<string>>;
};

const createAdapterMock = (): MockAdapter => ({
	create: mock(async (_event: CreateOutboxEvent, _transaction: Transaction<FakeTx>) => "returned-id"),
});

const event: CreateOutboxEvent = {
	aggregateId: "order-1",
	aggregateType: "Order",
	eventType: "order.created",
	payload: { total: 100 },
};

describe("OutboxClient", () => {
	let adapter: MockAdapter;
	let client: OutboxClient<FakeTx>;
	let tx: FakeTx;

	beforeEach(() => {
		adapter = createAdapterMock();
		client = new OutboxClient(adapter);
		tx = { query: () => {} };
	});

	describe("transaction argument", () => {
		it("forwards a { underlying } wrapper to the adapter unchanged", async () => {
			const wrapper = { underlying: tx };

			const id = await client.create(event, wrapper);

			expect(id).toBe("returned-id");
			expect(adapter.create).toHaveBeenCalledTimes(1);
			expect(adapter.create.mock.calls[0][0]).toBe(event);
			expect(adapter.create.mock.calls[0][1]).toBe(wrapper);
		});

		it("accepts the raw transaction object and wraps it for the adapter", async () => {
			await client.create(event, tx);

			const forwarded = adapter.create.mock.calls[0][1];
			expect(forwarded).toEqual({ underlying: tx });
			expect(forwarded.underlying).toBe(tx);
		});

		it("treats an object with an inherited (non-own) underlying property as a raw transaction", async () => {
			const raw = Object.create({ underlying: "from-prototype" }) as FakeTx;

			await client.create(event, raw);

			expect(adapter.create.mock.calls[0][1].underlying).toBe(raw);
		});

		it.each([undefined, null])(
			"rejects a missing transaction (%p) without calling the adapter",
			async (missing) => {
				await expect(client.create(event, missing as never)).rejects.toThrow(/transaction is required/);
				expect(adapter.create).not.toHaveBeenCalled();
			},
		);

		it("rejects a wrapper whose underlying transaction is missing", async () => {
			await expect(client.create(event, { underlying: undefined as never })).rejects.toThrow(
				/transaction is required/,
			);
			expect(adapter.create).not.toHaveBeenCalled();
		});
	});

	describe("event validation", () => {
		it.each([
			["aggregateId", ""],
			["aggregateId", "   "],
			["aggregateId", undefined],
			["aggregateId", 42],
			["aggregateType", ""],
			["aggregateType", null],
			["eventType", ""],
			["eventType", undefined],
		])("rejects %s = %p before reaching the adapter", async (field, value) => {
			const invalid = { ...event, [field]: value } as CreateOutboxEvent;

			await expect(client.create(invalid, tx)).rejects.toThrow(
				new RegExp(`CreateOutboxEvent\\.${field} must be a non-empty string`),
			);
			expect(adapter.create).not.toHaveBeenCalled();
		});

		it("rejects an undefined payload", async () => {
			const invalid = { ...event, payload: undefined };

			await expect(client.create(invalid, tx)).rejects.toThrow(/CreateOutboxEvent\.payload is required/);
			expect(adapter.create).not.toHaveBeenCalled();
		});

		it("accepts a null payload", async () => {
			await client.create({ ...event, payload: null }, tx);

			expect(adapter.create).toHaveBeenCalledTimes(1);
		});

		it.each(["", "not-a-uuid", "0190f0e0-0000-7000-8000-00000000000", 123])(
			"rejects a non-uuid id %p",
			async (id) => {
				const invalid = { ...event, id } as CreateOutboxEvent;

				await expect(client.create(invalid, tx)).rejects.toThrow(/CreateOutboxEvent\.id must be a UUID/);
				expect(adapter.create).not.toHaveBeenCalled();
			},
		);

		it("rejects a non-object event", async () => {
			await expect(client.create(null as never, tx)).rejects.toThrow(/event must be an object/);
			expect(adapter.create).not.toHaveBeenCalled();
		});
	});

	describe("with the PrismaAdapter", () => {
		let prismaTx: MockPrismaTransactionClient;
		let prismaClient: OutboxClient<MockPrismaTransactionClient>;

		beforeEach(() => {
			prismaTx = createPrismaTransactionMock();
			prismaClient = new OutboxClient(new PrismaAdapter());
		});

		it("inserts through a raw Prisma transaction client and returns the generated uuidv7", async () => {
			const id = await prismaClient.create(event, prismaTx);

			expect(id).toMatch(UUID_V7);
			expect(prismaTx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
			expect(prismaTx.$executeRawUnsafe.mock.calls[0][1]).toBe(id);
		});

		it("uses the caller-provided id for producer-side idempotency", async () => {
			const providedId = "0190f0e0-1234-7abc-8def-0123456789ab";

			const id = await prismaClient.create({ ...event, id: providedId }, { underlying: prismaTx });

			expect(id).toBe(providedId);
			expect(prismaTx.$executeRawUnsafe.mock.calls[0][1]).toBe(providedId);
		});
	});
});
