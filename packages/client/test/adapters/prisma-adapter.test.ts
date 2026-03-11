import { describe, expect, it, mock } from "bun:test";
import { PrismaAdapter, type PrismaTransactionClient } from "../../src/adapters/prisma-adapter";
import { OutboxStatus } from "../../src/models/outbox-status";
import type { Transaction } from "../../src/types/transaction";

describe("PrismaAdapter", () => {
	const mockTxClient: PrismaTransactionClient = {
		$executeRawUnsafe: mock(() => Promise.resolve(1)),
	};

	const transaction: Transaction<PrismaTransactionClient> = {
		underlying: mockTxClient,
	};

	const event = {
		aggregateId: "order-1",
		aggregateType: "Order",
		eventType: "order.created",
		payload: { total: 100 },
	};

	it("should insert into outbox and return generated id", async () => {
		const adapter = new PrismaAdapter();

		const id = await adapter.create(event, transaction);

		expect(id).toBeString();
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	it("should call $executeRawUnsafe with correct parameters", async () => {
		const adapter = new PrismaAdapter();

		const id = await adapter.create(event, transaction);

		expect(mockTxClient.$executeRawUnsafe).toHaveBeenCalledWith(
			expect.stringContaining("INSERT INTO outbox"),
			id,
			event.aggregateId,
			event.aggregateType,
			event.eventType,
			JSON.stringify(event.payload),
			OutboxStatus.PENDING,
			0,
		);
	});

	it("should set status as PENDING and attempts as 0", async () => {
		const adapter = new PrismaAdapter();

		await adapter.create(event, transaction);

		const callArgs = (mockTxClient.$executeRawUnsafe as ReturnType<typeof mock>).mock.calls.at(-1);
		expect(callArgs?.[6]).toBe(OutboxStatus.PENDING);
		expect(callArgs?.[7]).toBe(0);
	});

	it("should stringify the payload", async () => {
		const adapter = new PrismaAdapter();

		await adapter.create(event, transaction);

		const callArgs = (mockTxClient.$executeRawUnsafe as ReturnType<typeof mock>).mock.calls.at(-1);
		expect(callArgs?.[5]).toBe(JSON.stringify(event.payload));
	});
});
