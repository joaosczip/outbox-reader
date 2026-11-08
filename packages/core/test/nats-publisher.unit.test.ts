import { type Mock, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as jetstreamModule from "@nats-io/jetstream";
import * as natsModule from "nats";

import type { Logger } from "../src/logger";
import { OutboxRecord, OutboxStatus } from "../src/models/outbox-record";
import { NATSPublisher } from "../src/nats-publisher";
import type { RetryConfig } from "../src/types";
import { MockLogger } from "./mocks/mock-logger";

const SUBJECT_PREFIX = "events";

const retryConfig: RetryConfig = {
	jitter: "full",
	maxDelayInMs: 100,
	numOfAttempts: 1,
	startingDelayInMs: 10,
};

type PubAck = { seq: number; duplicate: boolean; stream: string };
type JsPublish = (subject: string, payload: string, opts?: { msgID?: string }) => Promise<PubAck>;

const buildRecord = (fields: { id: string; aggregateId: string; eventType: string }) =>
	new OutboxRecord({
		...fields,
		aggregateType: "Order",
		payload: { orderId: fields.aggregateId },
		status: OutboxStatus.PENDING,
		attempts: 0,
	});

describe("NATSPublisher (unit)", () => {
	let publisher: NATSPublisher;
	let logger: MockLogger;
	let jsPublish: Mock<JsPublish>;
	let connectSpy: ReturnType<typeof spyOn>;
	let jetstreamSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		let seq = 0;
		jsPublish = mock<JsPublish>(async () => ({ seq: ++seq, duplicate: false, stream: "S" }));
		const fakeConnection = { close: async () => {}, isClosed: () => false };
		connectSpy = spyOn(natsModule, "connect").mockResolvedValue(fakeConnection as never);
		jetstreamSpy = spyOn(jetstreamModule, "jetstream").mockReturnValue({ publish: jsPublish } as never);

		logger = new MockLogger();
		publisher = new NATSPublisher({
			retryConfig,
			logger: logger as unknown as Logger,
			connectionConfig: { servers: "nats://localhost:4222" },
			subjectPrefix: SUBJECT_PREFIX,
		});
	});

	afterEach(async () => {
		await publisher.close();
		connectSpy.mockRestore();
		jetstreamSpy.mockRestore();
	});

	it("publishes with msgID equal to record.id and subject from prefix + eventType", async () => {
		const record = buildRecord({ id: "evt-1", aggregateId: "order-1", eventType: "OrderCreated" });

		const result = await publisher.publish({ record });

		expect(connectSpy).toHaveBeenCalledTimes(1);
		expect(jsPublish).toHaveBeenCalledTimes(1);
		const [subject, payload, opts] = jsPublish.mock.calls[0];
		expect(subject).toBe(`${SUBJECT_PREFIX}.OrderCreated`);
		expect(JSON.parse(payload)).toEqual({ orderId: "order-1" });
		expect(opts?.msgID).toBe("evt-1");
		expect(result).toBe(1);
	});

	it("regression: distinct events of the same aggregate get distinct msgIDs", async () => {
		const created = buildRecord({ id: "evt-1", aggregateId: "order-1", eventType: "OrderCreated" });
		const paid = buildRecord({ id: "evt-2", aggregateId: "order-1", eventType: "OrderPaid" });

		await publisher.publish({ record: created });
		await publisher.publish({ record: paid });

		const msgIDs = jsPublish.mock.calls.map(([, , opts]) => opts?.msgID);
		expect(msgIDs).toEqual(["evt-1", "evt-2"]);
		expect(msgIDs).not.toContain("order-1");
	});

	it("retries of the same record reuse the same msgID", async () => {
		const record = buildRecord({ id: "evt-1", aggregateId: "order-1", eventType: "OrderCreated" });

		await publisher.publish({ record });
		await publisher.publish({ record });

		const msgIDs = jsPublish.mock.calls.map(([, , opts]) => opts?.msgID);
		expect(msgIDs).toEqual(["evt-1", "evt-1"]);
	});

	it("logs a warning and does not throw when the PubAck is flagged as duplicate", async () => {
		jsPublish.mockResolvedValueOnce({ seq: 7, duplicate: true, stream: "S" });
		const record = buildRecord({ id: "evt-1", aggregateId: "order-1", eventType: "OrderCreated" });

		const result = await publisher.publish({ record });

		expect(result).toBe(7);
		const warnings = logger.logs.filter((l) => l.level === "warn");
		expect(warnings).toHaveLength(1);
		expect(warnings[0].extra).toMatchObject({ id: "evt-1", aggregateId: "order-1", sequenceNumber: 7 });
	});

	it("does not log a duplicate warning for a fresh PubAck", async () => {
		const record = buildRecord({ id: "evt-1", aggregateId: "order-1", eventType: "OrderCreated" });

		await publisher.publish({ record });

		expect(logger.logs.filter((l) => l.level === "warn")).toHaveLength(0);
	});

	it("rethrows and logs an error when the JetStream publish fails", async () => {
		const failure = new Error("boom");
		jsPublish.mockRejectedValueOnce(failure);
		const record = buildRecord({ id: "evt-1", aggregateId: "order-1", eventType: "OrderCreated" });

		await expect(publisher.publish({ record })).rejects.toThrow("boom");
		const errors = logger.logs.filter((l) => l.level === "error");
		expect(errors).toHaveLength(1);
		expect(errors[0].error).toBe(failure);
	});
	describe("JetStream client reuse", () => {
		it("creates the JetStream client once across multiple publishes", async () => {
			const records = ["evt-1", "evt-2", "evt-3"].map((id) =>
				buildRecord({ id, aggregateId: "order-1", eventType: "OrderCreated" }),
			);

			for (const record of records) {
				await publisher.publish({ record });
			}

			expect(jsPublish).toHaveBeenCalledTimes(3);
			expect(jetstreamSpy).toHaveBeenCalledTimes(1);
			expect(connectSpy).toHaveBeenCalledTimes(1);
		});

		it("recreates the JetStream client on the new connection after close and reconnect", async () => {
			const firstConnection = { close: async () => {}, isClosed: () => false };
			const secondConnection = { close: async () => {}, isClosed: () => false };
			connectSpy.mockResolvedValueOnce(firstConnection as never).mockResolvedValueOnce(secondConnection as never);
			const record = buildRecord({ id: "evt-1", aggregateId: "order-1", eventType: "OrderCreated" });

			await publisher.publish({ record });
			await publisher.close();
			await publisher.publish({ record });
			await publisher.publish({ record });

			expect(connectSpy).toHaveBeenCalledTimes(2);
			expect(jetstreamSpy).toHaveBeenCalledTimes(2);
			expect(jetstreamSpy.mock.calls[0][0]).toBe(firstConnection);
			expect(jetstreamSpy.mock.calls[1][0]).toBe(secondConnection);
			expect(jsPublish).toHaveBeenCalledTimes(3);
		});

		it("creates the JetStream client when connect() is called explicitly before publishing", async () => {
			await publisher.connect();
			expect(jetstreamSpy).toHaveBeenCalledTimes(1);

			await publisher.publish({ record: buildRecord({ id: "evt-1", aggregateId: "o-1", eventType: "E" }) });

			expect(jetstreamSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe("hot-path logging", () => {
		it("does not log at info for successful publishes once connected", async () => {
			await publisher.connect();
			logger.logs = [];

			await publisher.publish({ record: buildRecord({ id: "evt-1", aggregateId: "order-1", eventType: "A" }) });
			await publisher.publish({ record: buildRecord({ id: "evt-2", aggregateId: "order-2", eventType: "B" }) });

			expect(logger.logs.filter((l) => l.level === "info")).toHaveLength(0);
			const debugLogs = logger.logs.filter((l) => l.level === "debug");
			expect(debugLogs).toHaveLength(2);
			expect(debugLogs.map((l) => l.extra)).toEqual([
				{ subject: `${SUBJECT_PREFIX}.A`, id: "evt-1", aggregateId: "order-1", aggregateType: "Order", sequenceNumber: 1 },
				{ subject: `${SUBJECT_PREFIX}.B`, id: "evt-2", aggregateId: "order-2", aggregateType: "Order", sequenceNumber: 2 },
			]);
		});

		it("does not emit a success debug log when the publish fails", async () => {
			jsPublish.mockRejectedValueOnce(new Error("boom"));

			await expect(
				publisher.publish({ record: buildRecord({ id: "evt-1", aggregateId: "o-1", eventType: "E" }) }),
			).rejects.toThrow("boom");

			expect(logger.logs.filter((l) => l.level === "debug")).toHaveLength(0);
			expect(logger.logs.filter((l) => l.level === "error")).toHaveLength(1);
		});
	});
});
