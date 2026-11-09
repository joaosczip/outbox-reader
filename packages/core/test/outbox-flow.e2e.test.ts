import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type JetStreamManager, jetstream, jetstreamManager } from "@nats-io/jetstream";
import { type NatsConnection, connect } from "nats";
import { Pool } from "pg";
import type { LogicalReplicationService } from "pg-logical-replication";

import { Logger } from "../src/logger";
import { NATSPublisher } from "../src/nats-publisher";
import { OutboxProcessor } from "../src/outbox-processor";
import { OutboxRepository } from "../src/outbox-repository";
import { startReplication } from "../src/replication";
import { RetryQueue } from "../src/retry-queue";
import type { RetryConfig } from "../src/types";
import { createWalChangeHandler } from "../src/wal-change-handler";
import { testConfig } from "./setup";

// The publisher sends to `<prefix>.<eventType>`; the stream covers `<prefix>.>`.
const SUBJECT_PREFIX = testConfig.testSubjectPrefix.replace(/\.$/, "");

const dbRetryConfig: RetryConfig = {
	jitter: "full",
	maxDelayInMs: 2000,
	numOfAttempts: 5,
	startingDelayInMs: 200,
};

const natsRetryConfig: RetryConfig = {
	jitter: "full",
	maxDelayInMs: 5000,
	numOfAttempts: 5,
	startingDelayInMs: 500,
};

async function waitFor<T>(
	predicate: () => Promise<T | null | undefined | false>,
	{ timeout = 10_000, interval = 100 } = {},
): Promise<T> {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const result = await predicate();
		if (result) return result;
		await new Promise((resolve) => setTimeout(resolve, interval));
	}
	throw new Error(`waitFor timed out after ${timeout}ms`);
}

describe("Outbox Flow E2E", () => {
	let pool: Pool;
	let outboxRepository: OutboxRepository;
	let outboxProcessor: OutboxProcessor;
	let natsPublisher: NATSPublisher;
	let replicationService: LogicalReplicationService;
	let retryQueue: RetryQueue;
	const replicationErrors: unknown[] = [];
	let natsConn: NatsConnection;
	let jsm: JetStreamManager;
	const logger = new Logger("e2e-test");
	const insertedIds: string[] = [];

	beforeAll(async () => {
		pool = new Pool({ connectionString: testConfig.connectionString, max: 5 });

		await pool.query(`
			CREATE TABLE IF NOT EXISTS outbox (
				id VARCHAR(255) PRIMARY KEY,
				aggregate_id VARCHAR(255) NOT NULL,
				aggregate_type VARCHAR(255) NOT NULL,
				event_type VARCHAR(255) NOT NULL,
				payload JSONB NOT NULL,
				sequence_number BIGINT NULL,
				created_at TIMESTAMP NOT NULL DEFAULT NOW(),
				processed_at TIMESTAMP NULL,
				status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
				attempts INTEGER NOT NULL DEFAULT 0
			)
		`);

		// Clean up any stale replication slot from a previous failed run
		await pool.query("SELECT pg_drop_replication_slot($1)", [testConfig.replicationSlot]).catch(() => {});

		// Set up NATS connection and JetStream
		natsConn = await connect({ servers: testConfig.natsUrl });
		jsm = await jetstreamManager(natsConn as unknown as Parameters<typeof jetstreamManager>[0]);

		// Delete stream if it exists from a previous run, then recreate
		await jsm.streams.delete(testConfig.streamName).catch(() => {});
		await jsm.streams.add({
			name: testConfig.streamName,
			subjects: [`${testConfig.testSubjectPrefix}>`],
		});

		// Wire up application components exactly like app.ts
		outboxRepository = new OutboxRepository({ pool, retryConfig: dbRetryConfig });
		natsPublisher = new NATSPublisher({
			logger,
			retryConfig: natsRetryConfig,
			connectionConfig: { servers: testConfig.natsUrl, name: "e2e-test-publisher" },
			subjectPrefix: SUBJECT_PREFIX,
		});
		outboxProcessor = new OutboxProcessor({ outboxRepository, logger, maxAttempts: natsRetryConfig.numOfAttempts });
		await natsPublisher.connect();

		retryQueue = new RetryQueue({
			processor: outboxProcessor,
			publisher: natsPublisher,
			outboxRepository,
			logger,
			config: natsRetryConfig,
			maxAttempts: natsRetryConfig.numOfAttempts,
		});

		// Create the replication slot before subscribing
		const replPool = new Pool({ connectionString: `${testConfig.connectionString}?replication=database`, max: 1 });
		await replPool.query(`CREATE_REPLICATION_SLOT "${testConfig.replicationSlot}" LOGICAL wal2json`);
		await replPool.end();

		// startReplication must resolve once streaming has started (it used to hang until the
		// stream ended), so the race below fails the suite if it regresses.
		replicationService = await Promise.race([
			startReplication({
				connectionString: testConfig.connectionString,
				slotName: testConfig.replicationSlot,
				tableName: "outbox",
				onChange: createWalChangeHandler({
					processor: outboxProcessor,
					repository: outboxRepository,
					publisher: natsPublisher,
					retryQueue,
					logger,
					concurrency: 5,
				}),
				onError: (error) => replicationErrors.push(error),
			}),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("startReplication did not resolve after streaming started")), 10_000),
			),
		]);

		// Give replication a moment to establish
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}, 30_000);

	afterAll(async () => {
		retryQueue?.stop();
		await replicationService?.stop().catch(() => {});

		// Clean up test records
		if (insertedIds.length > 0) {
			await pool.query("DELETE FROM outbox WHERE id = ANY($1)", [insertedIds]).catch(() => {});
		}

		await natsPublisher?.close().catch(() => {});

		// Clean up JetStream stream
		await jsm?.streams.delete(testConfig.streamName).catch(() => {});
		await natsConn?.close().catch(() => {});

		// Drop the test replication slot
		await pool.query("SELECT pg_drop_replication_slot($1)", [testConfig.replicationSlot]).catch(() => {});

		await pool?.end().catch(() => {});
	}, 15_000);

	it("processes a new outbox record end-to-end", async () => {
		const aggregateId = crypto.randomUUID();
		const recordId = crypto.randomUUID();
		const payload = JSON.stringify({ orderId: "123", amount: 99.99 });
		const eventType = "order_created";

		insertedIds.push(recordId);

		await pool.query(
			`INSERT INTO outbox (id, aggregate_id, aggregate_type, event_type, payload, status, attempts)
			 VALUES ($1, $2, $3, $4, $5, 'PENDING', 0)`,
			[recordId, aggregateId, "Order", eventType, payload],
		);

		// Wait for the DB record to be marked as PROCESSED
		const processedRecord = await waitFor(async () => {
			const result = await pool.query("SELECT * FROM outbox WHERE id = $1 AND status = 'PROCESSED'", [recordId]);
			return result.rows[0] || null;
		});

		expect(processedRecord.status).toBe("PROCESSED");
		expect(processedRecord.processed_at).not.toBeNull();
		expect(processedRecord.attempts).toBe(1);

		// Verify the message was published to NATS JetStream
		const js = jetstream(natsConn as unknown as Parameters<typeof jetstream>[0]);
		const consumer = await js.consumers.get(testConfig.streamName);
		const messages = await consumer.fetch({ max_messages: 1, expires: 5_000 });

		let receivedMessage: { subject: string; data: string; headers: Record<string, string | undefined> } | null =
			null;
		for await (const msg of messages) {
			receivedMessage = {
				subject: msg.subject,
				data: msg.string(),
				headers: {
					msgId: msg.headers?.get("Nats-Msg-Id"),
					id: msg.headers?.get("Outbox-Id"),
					aggregateId: msg.headers?.get("Outbox-Aggregate-Id"),
					aggregateType: msg.headers?.get("Outbox-Aggregate-Type"),
					eventType: msg.headers?.get("Outbox-Event-Type"),
					createdAt: msg.headers?.get("Outbox-Created-At"),
				},
			};
			msg.ack();
			break;
		}

		expect(receivedMessage).not.toBeNull();
		expect(receivedMessage?.subject).toBe(`${SUBJECT_PREFIX}.${eventType}`);
		expect(JSON.parse(receivedMessage?.data ?? "")).toEqual(JSON.parse(payload));
		expect(receivedMessage?.headers).toMatchObject({
			msgId: recordId,
			id: recordId,
			aggregateId,
			aggregateType: "Order",
			eventType,
		});
		expect(Number.isNaN(Date.parse(receivedMessage?.headers.createdAt ?? ""))).toBe(false);
		expect(replicationErrors).toEqual([]);
	}, 20_000);

	it("processes multiple outbox records", async () => {
		const records = [
			{
				id: crypto.randomUUID(),
				aggregateId: crypto.randomUUID(),
				eventType: "user_created",
				payload: JSON.stringify({ userId: "u1" }),
			},
			{
				id: crypto.randomUUID(),
				aggregateId: crypto.randomUUID(),
				eventType: "payment_received",
				payload: JSON.stringify({ paymentId: "p1", amount: 50 }),
			},
			{
				id: crypto.randomUUID(),
				aggregateId: crypto.randomUUID(),
				eventType: "item_shipped",
				payload: JSON.stringify({ shipmentId: "s1" }),
			},
		];

		for (const record of records) {
			insertedIds.push(record.id);
			await pool.query(
				`INSERT INTO outbox (id, aggregate_id, aggregate_type, event_type, payload, status, attempts)
				 VALUES ($1, $2, $3, $4, $5, 'PENDING', 0)`,
				[record.id, record.aggregateId, "TestAggregate", record.eventType, record.payload],
			);
		}

		// Wait for all records to be processed in DB
		await waitFor(async () => {
			const result = await pool.query(
				"SELECT COUNT(*)::int as count FROM outbox WHERE id = ANY($1) AND status = 'PROCESSED'",
				[records.map((r) => r.id)],
			);
			return result.rows[0].count === records.length || null;
		});

		// Verify all records are PROCESSED
		const result = await pool.query("SELECT * FROM outbox WHERE id = ANY($1) ORDER BY created_at", [
			records.map((r) => r.id),
		]);

		expect(result.rows).toHaveLength(3);
		for (const row of result.rows) {
			expect(row.status).toBe("PROCESSED");
			expect(row.processed_at).not.toBeNull();
			expect(row.attempts).toBe(1);
		}

		// Verify messages arrived in NATS
		const js = jetstream(natsConn as unknown as Parameters<typeof jetstream>[0]);
		const consumer = await js.consumers.get(testConfig.streamName);
		const messages = await consumer.fetch({ max_messages: 10, expires: 5_000 });

		const receivedSubjects: string[] = [];
		for await (const msg of messages) {
			receivedSubjects.push(msg.subject);
			msg.ack();
		}

		const expectedSubjects = records.map((r) => `${SUBJECT_PREFIX}.${r.eventType}`);
		for (const subject of expectedSubjects) {
			expect(receivedSubjects).toContain(subject);
		}
	}, 20_000);
});
