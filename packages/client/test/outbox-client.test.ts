import { describe, expect, it, mock } from "bun:test";
import { OutboxClient } from "../src/outbox-client";
import type { OutboxAdapter } from "../src/types/adapter";
import type { Transaction } from "../src/types/transaction";

describe("OutboxClient", () => {
	const mockAdapter: OutboxAdapter<string> = {
		create: mock(() => Promise.resolve("generated-id-123")),
	};

	const transaction: Transaction<string> = {
		underlying: "mock-tx",
	};

	it("should delegate create to the adapter", async () => {
		const client = new OutboxClient(mockAdapter);
		const event = {
			aggregateId: "order-1",
			aggregateType: "Order",
			eventType: "order.created",
			payload: { total: 100 },
		};

		const id = await client.create(event, transaction);

		expect(id).toBe("generated-id-123");
		expect(mockAdapter.create).toHaveBeenCalledWith(event, transaction);
	});
});
