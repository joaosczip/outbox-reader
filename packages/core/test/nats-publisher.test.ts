import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { NatsContainer, type StartedNatsContainer } from "@testcontainers/nats";
import { type NatsConnection, connect } from "nats";

import { Logger } from "../src/logger";
import { OutboxRecord, OutboxStatus } from "../src/models/outbox-record";
import { NATSPublisher } from "../src/nats-publisher";
import type { NATSConnectionConfig, RetryConfig } from "../src/types";

const STREAM_NAME = "PUBLISHER_TEST";
const SUBJECT_PREFIX = "events";

const retryConfig: RetryConfig = {
	jitter: "full",
	maxDelayInMs: 10000,
	numOfAttempts: 10,
	startingDelayInMs: 1000,
};

describe("NATSPublisher", () => {
	let container: StartedNatsContainer;
	let natsConn: NatsConnection;
	let connectionConfig: NATSConnectionConfig;
	const logger = new Logger("test");

	beforeAll(async () => {
		container = await new NatsContainer("nats:2.12.6-alpine").withJetStream().start();

		connectionConfig = container.getConnectionOptions() as NATSConnectionConfig;

		natsConn = await connect(connectionConfig);
		const jsm = await jetstreamManager(natsConn as Parameters<typeof jetstreamManager>[0]);
		await jsm.streams.add({
			name: STREAM_NAME,
			subjects: [`${SUBJECT_PREFIX}.>`],
		});
	}, 30_000);

	afterAll(async () => {
		await natsConn?.close();
		await container?.stop();
	});

	it("should instantiate with connection config", () => {
		const publisher = new NATSPublisher({ retryConfig, logger, connectionConfig, subjectPrefix: SUBJECT_PREFIX });

		expect(publisher).toBeInstanceOf(NATSPublisher);
		expect(publisher.isConnected()).toBe(false);
	});

	it("should accept multiple servers in configuration", () => {
		const publisher = new NATSPublisher({
			retryConfig,
			logger,
			subjectPrefix: SUBJECT_PREFIX,
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
			const publisher = new NATSPublisher({
				retryConfig,
				logger,
				connectionConfig,
				subjectPrefix: SUBJECT_PREFIX,
			});

			await publisher.connect();

			expect(publisher.isConnected()).toBe(true);
			await publisher.close();
		});

		it("is a no-op when called a second time", async () => {
			const publisher = new NATSPublisher({
				retryConfig,
				logger,
				connectionConfig,
				subjectPrefix: SUBJECT_PREFIX,
			});

			await publisher.connect();
			await publisher.connect();

			expect(publisher.isConnected()).toBe(true);
			await publisher.close();
		});
	});

	describe("publish()", () => {
		it("calls connect() internally when not yet connected", async () => {
			const publisher = new NATSPublisher({
				retryConfig,
				logger,
				connectionConfig,
				subjectPrefix: SUBJECT_PREFIX,
			});

			const record = new OutboxRecord({
				id: "1",
				eventType: "test.event",
				aggregateId: "agg-1",
				aggregateType: "TestAggregate",
				payload: "{}",
				status: OutboxStatus.PENDING,
				attempts: 0,
			});

			expect(publisher.isConnected()).toBe(false);
			await publisher.publish({ record });
			expect(publisher.isConnected()).toBe(true);

			await publisher.close();
		});

		it("publishes to subject built from subjectPrefix and eventType", async () => {
			const js = jetstream(natsConn as Parameters<typeof jetstream>[0]);

			// Create consumer before publishing so only messages published after this point are captured
			const consumer = await js.consumers.get(STREAM_NAME, {
				filter_subjects: `${SUBJECT_PREFIX}.OrderCreated`,
				deliver_policy: "new",
			});

			const publisher = new NATSPublisher({
				retryConfig,
				logger,
				connectionConfig,
				subjectPrefix: SUBJECT_PREFIX,
			});

			const record = new OutboxRecord({
				id: "2",
				eventType: "OrderCreated",
				aggregateId: "agg-2",
				aggregateType: "Order",
				payload: '{"orderId":"123"}',
				status: OutboxStatus.PENDING,
				attempts: 0,
			});

			await publisher.publish({ record });
			await publisher.close();

			const messages = await consumer.fetch({ max_messages: 1, expires: 3_000 });

			let received: { subject: string; data: string } | null = null;
			for await (const msg of messages) {
				received = { subject: msg.subject, data: msg.string() };
				msg.ack();
				break;
			}

			expect(received?.subject).toBe(`${SUBJECT_PREFIX}.OrderCreated`);
			expect(JSON.parse(received?.data ?? "")).toEqual({ orderId: "123" });
		});
	});
});
