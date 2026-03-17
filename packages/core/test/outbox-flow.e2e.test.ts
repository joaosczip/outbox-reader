import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { jetstream } from "@nats-io/jetstream";
import { type JetStreamManager, jetstreamManager } from "@nats-io/jetstream";
import { type NatsConnection, connect } from "nats";
import pAll from "p-all";
import { Pool } from "pg";
import { LogicalReplicationService, type Wal2Json, Wal2JsonPlugin } from "pg-logical-replication";

import { Logger } from "../src/logger";
import { NATSPublisher } from "../src/nats-publisher";
import { OutboxProcessor } from "../src/outbox-processor";
import { OutboxRepository } from "../src/outbox-repository";
import type { RetryConfig } from "../src/types";

const DB_CONNECTION_STRING = process.env.DATABASE_URL || "postgres://root:root@localhost:5433/ecomm-be";
const NATS_URL = process.env.TARGET_NATS_URL || "nats://localhost:4222";
const REPLICATION_SLOT = process.env.REPLICATION_SLOT_NAME || "outbox_slot_e2e_test";
const STREAM_NAME = process.env.JETSTREAM_STREAM_NAME || "OUTBOX_E2E_TEST";
const TEST_SUBJECT_PREFIX = "e2e.test.";

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
	let natsConn: NatsConnection;
	let jsm: JetStreamManager;
	const logger = new Logger("e2e-test");
	const insertedIds: string[] = [];

	beforeAll(async () => {
		pool = new Pool({ connectionString: DB_CONNECTION_STRING, max: 5 });

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
		await pool.query("SELECT pg_drop_replication_slot($1)", [REPLICATION_SLOT]).catch(() => {});

		// Set up NATS connection and JetStream
		natsConn = await connect({ servers: NATS_URL });
		jsm = await jetstreamManager(natsConn as unknown as Parameters<typeof jetstreamManager>[0]);

		// Delete stream if it exists from a previous run, then recreate
		await jsm.streams.delete(STREAM_NAME).catch(() => {});
		await jsm.streams.add({
			name: STREAM_NAME,
			subjects: [`${TEST_SUBJECT_PREFIX}>`],
		});

		// Wire up application components
		outboxRepository = new OutboxRepository({ pool, retryConfig: dbRetryConfig });
		natsPublisher = new NATSPublisher({
			logger,
			retryConfig: natsRetryConfig,
			connectionConfig: { servers: NATS_URL, name: "e2e-test-publisher" },
		});
		outboxProcessor = new OutboxProcessor({ outboxRepository, logger });

		await natsPublisher.connect();

		// Create the replication slot before subscribing
		const replPool = new Pool({ connectionString: `${DB_CONNECTION_STRING}?replication=database`, max: 1 });
		await replPool.query(`CREATE_REPLICATION_SLOT "${REPLICATION_SLOT}" LOGICAL wal2json`);
		await replPool.end();

		// Start WAL replication (mirrors app.ts wiring)
		replicationService = new LogicalReplicationService(
			{ connectionString: `${DB_CONNECTION_STRING}?replication=database` },
			{ flowControl: { enabled: true }, acknowledge: { auto: true, timeoutSeconds: 0 } },
		);

		replicationService.on("data", async (_lsn: string, log: Wal2Json.Output) => {
			const outboxRecords = outboxProcessor.filterChanges(log);

			const ids = outboxRecords.map((r) => r.id as string);
			const fetchedRecords = await outboxRepository.findUnprocessedByIds(ids);
			const fetchedMap = new Map(fetchedRecords.map((r) => [r.id, r]));

			await pAll(
				outboxRecords.map(
					(record) => () =>
						outboxProcessor.processInserts({
							insertedRecord: record,
							prefetchedOutbox: fetchedMap.get(record.id as string) ?? null,
							publisher: natsPublisher,
						}),
				),
				{ concurrency: 5 },
			);
		});

		const plugin = new Wal2JsonPlugin();
		replicationService.subscribe(plugin, REPLICATION_SLOT);

		// Give replication a moment to establish
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}, 30_000);

	afterAll(async () => {
		await replicationService?.stop().catch(() => {});

		// Clean up test records
		if (insertedIds.length > 0) {
			await pool.query("DELETE FROM outbox WHERE id = ANY($1)", [insertedIds]).catch(() => {});
		}

		await natsPublisher?.close().catch(() => {});

		// Clean up JetStream stream
		await jsm?.streams.delete(STREAM_NAME).catch(() => {});
		await natsConn?.close().catch(() => {});

		// Drop the test replication slot
		await pool.query("SELECT pg_drop_replication_slot($1)", [REPLICATION_SLOT]).catch(() => {});

		await pool?.end().catch(() => {});
	}, 15_000);

	it("processes a new outbox record end-to-end", async () => {
		const aggregateId = crypto.randomUUID();
		const recordId = crypto.randomUUID();
		const payload = JSON.stringify({ orderId: "123", amount: 99.99 });
		const eventType = `${TEST_SUBJECT_PREFIX}order_created`;

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
		const consumer = await js.consumers.get(STREAM_NAME);
		const messages = await consumer.fetch({ max_messages: 1, expires: 5_000 });

		let receivedMessage: { subject: string; data: string } | null = null;
		for await (const msg of messages) {
			receivedMessage = {
				subject: msg.subject,
				data: msg.string(),
			};
			msg.ack();
			break;
		}

		expect(receivedMessage).not.toBeNull();
		expect(receivedMessage?.subject).toBe(eventType);
		expect(JSON.parse(receivedMessage?.data ?? "")).toEqual(JSON.parse(payload));
	}, 20_000);

	it("processes multiple outbox records", async () => {
		const records = [
			{
				id: crypto.randomUUID(),
				aggregateId: crypto.randomUUID(),
				eventType: `${TEST_SUBJECT_PREFIX}user_created`,
				payload: JSON.stringify({ userId: "u1" }),
			},
			{
				id: crypto.randomUUID(),
				aggregateId: crypto.randomUUID(),
				eventType: `${TEST_SUBJECT_PREFIX}payment_received`,
				payload: JSON.stringify({ paymentId: "p1", amount: 50 }),
			},
			{
				id: crypto.randomUUID(),
				aggregateId: crypto.randomUUID(),
				eventType: `${TEST_SUBJECT_PREFIX}item_shipped`,
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
		const consumer = await js.consumers.get(STREAM_NAME);
		const messages = await consumer.fetch({ max_messages: 10, expires: 5_000 });

		const receivedSubjects: string[] = [];
		for await (const msg of messages) {
			receivedSubjects.push(msg.subject);
			msg.ack();
		}

		const expectedSubjects = records.map((r) => r.eventType);
		for (const subject of expectedSubjects) {
			expect(receivedSubjects).toContain(subject);
		}
	}, 20_000);
});
