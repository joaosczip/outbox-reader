import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Logger } from "../src/logger";
import { OutboxRecord, OutboxStatus } from "../src/models/outbox-record";
import { NATSPublisher } from "../src/nats-publisher";
import type { RetryConfig } from "../src/types";

const mockNatsConnection = {
	isClosed: mock(() => false),
	close: mock(async () => {}),
};

mock.module("nats", () => ({
	connect: mock(async () => mockNatsConnection),
}));

mock.module("@nats-io/jetstream", () => ({
	jetstream: mock(() => ({
		publish: mock(async () => ({ seq: 1 })),
	})),
}));

describe("NATSPublisher", () => {
	const retryConfig: RetryConfig = {
		jitter: "full",
		maxDelayInMs: 10000,
		numOfAttempts: 10,
		startingDelayInMs: 1000,
	};

	const connectionConfig = {
		servers: ["nats://localhost:4222"],
		name: "test-publisher",
	};

	let logger: Logger;

	beforeEach(() => {
		logger = new Logger("test");
		mockNatsConnection.isClosed.mockClear();
		mockNatsConnection.close.mockClear();
	});

	it("should instantiate with connection config", () => {
		const publisher = new NATSPublisher({ retryConfig, logger, connectionConfig });

		expect(publisher).toBeInstanceOf(NATSPublisher);
		expect(publisher.isConnected()).toBe(false);
	});

	it("should accept multiple servers in configuration", () => {
		const publisher = new NATSPublisher({
			retryConfig,
			logger,
			connectionConfig: {
				servers: ["nats://server1:4222", "nats://server2:4222"],
				name: "test-publisher",
				user: "testuser",
				pass: "testpass",
				maxReconnectAttempts: 5,
				reconnectTimeWait: 1000,
			},
		});

		expect(publisher).toBeInstanceOf(NATSPublisher);
	});

	describe("connect()", () => {
		it("establishes a NATS connection", async () => {
			const { connect } = await import("nats");
			const publisher = new NATSPublisher({ retryConfig, logger, connectionConfig });

			await publisher.connect();

			expect(connect).toHaveBeenCalledWith(connectionConfig);
			expect(publisher.isConnected()).toBe(true);
		});

		it("is a no-op when called a second time", async () => {
			const { connect } = await import("nats");
			(connect as ReturnType<typeof mock>).mockClear();

			const publisher = new NATSPublisher({ retryConfig, logger, connectionConfig });

			await publisher.connect();
			await publisher.connect();

			expect(connect).toHaveBeenCalledTimes(1);
		});
	});

	describe("publish()", () => {
		it("calls connect() internally when not yet connected", async () => {
			const publisher = new NATSPublisher({ retryConfig, logger, connectionConfig });
			const connectSpy = spyOn(publisher, "connect");

			const record = new OutboxRecord({
				id: "1",
				eventType: "test.event",
				aggregateId: "agg-1",
				aggregateType: "TestAggregate",
				payload: "{}",
				status: OutboxStatus.PENDING,
				attempts: 0,
			});

			await publisher.publish({ record });

			expect(connectSpy).toHaveBeenCalledTimes(1);
		});
	});
});
