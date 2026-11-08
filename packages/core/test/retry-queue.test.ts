import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { OutboxRecord, OutboxStatus } from "../src/models/outbox-record";
import { RetryQueue } from "../src/retry-queue";
import type { RetryConfig } from "../src/types";
import { MockLogger } from "./mocks/mock-logger";
import { MockOutboxProcessor } from "./mocks/mock-outbox-processor";
import { MockOutboxRepository } from "./mocks/mock-outbox-repository";
import { MockPublisher } from "./mocks/mock-publisher";

// Use a short delay config so tests run fast
const config: RetryConfig = {
	jitter: "none", // deterministic delays in tests
	maxDelayInMs: 500,
	numOfAttempts: 3,
	startingDelayInMs: 50,
};

const maxAttempts = 5;

function makeRecord(id: string, attempts = 0): OutboxRecord {
	return new OutboxRecord({
		id,
		aggregateId: "agg-1",
		aggregateType: "T",
		eventType: "e.v",
		payload: {},
		status: OutboxStatus.PENDING,
		attempts,
	});
}

describe("RetryQueue", () => {
	let queue: RetryQueue;
	let mockProcessor: MockOutboxProcessor;
	let mockRepository: MockOutboxRepository;
	let mockPublisher: MockPublisher;
	let mockLogger: MockLogger;

	beforeEach(() => {
		mockProcessor = new MockOutboxProcessor();
		mockRepository = new MockOutboxRepository();
		mockPublisher = new MockPublisher();
		mockLogger = new MockLogger();
		queue = new RetryQueue({
			processor: mockProcessor,
			publisher: mockPublisher,
			outboxRepository: mockRepository,
			logger: mockLogger,
			config,
			maxAttempts,
		});
	});

	afterEach(() => {
		queue.stop();
	});

	it("should not call processInserts immediately when a record is enqueued", () => {
		queue.enqueue(makeRecord("rec-1"));
		expect(mockProcessor.processInsertsCalls).toHaveLength(0);
	});

	it("should call processInserts after the first delay when a record is enqueued", async () => {
		mockProcessor.setShouldSucceed();
		queue.enqueue(makeRecord("rec-1"));

		await Bun.sleep((config.startingDelayInMs ?? 50) + 30);

		expect(mockProcessor.processInsertsCalls).toHaveLength(1);
		expect(mockProcessor.processInsertsCalls[0].insertedRecord.id).toBe("rec-1");
	});

	it("should always pass prefetchedOutbox as undefined to force a fresh DB read", async () => {
		mockProcessor.setShouldSucceed();
		queue.enqueue(makeRecord("rec-2"));

		await Bun.sleep((config.startingDelayInMs ?? 50) + 30);

		expect(mockProcessor.processInsertsCalls[0].prefetchedOutbox).toBeUndefined();
	});

	it("should retry on failure up to numOfAttempts times total", async () => {
		mockProcessor.setError(new Error("NATS down"));
		queue.enqueue(makeRecord("rec-3"));

		// Wait long enough for all 3 attempts (50 + 100 + 200 = 350ms with no jitter)
		await Bun.sleep(600);

		expect(mockProcessor.processInsertsCalls).toHaveLength(3);
	});

	it("should call markAsFailed after exhausting all retries", async () => {
		const record = makeRecord("rec-4", 2);
		mockProcessor.setError(new Error("NATS down"));
		queue.enqueue(record);

		await Bun.sleep(600);

		expect(mockRepository.markAsFailedCalls).toHaveLength(1);
		expect(mockRepository.markAsFailedCalls[0].id).toBe("rec-4");
	});

	it("should mark the record FAILED (not DEAD) when the next attempt stays below maxAttempts", async () => {
		const record = makeRecord("rec-below", maxAttempts - 2);
		mockRepository.addRecord(record);
		mockProcessor.setError(new Error("NATS down"));
		queue.enqueue(record);

		await Bun.sleep(600);

		expect(mockRepository.markAsFailedCalls).toEqual([{ id: "rec-below", attempts: maxAttempts - 2 }]);
		expect(mockRepository.markAsDeadCalls).toHaveLength(0);
		expect(mockRepository.getRecord("rec-below")?.status).toBe(OutboxStatus.FAILED);
	});

	it("should mark the record DEAD instead of FAILED when exhausting retries reaches maxAttempts", async () => {
		const record = makeRecord("rec-dead", maxAttempts - 1);
		mockRepository.addRecord(record);
		mockProcessor.setError(new Error("NATS down"));
		queue.enqueue(record);

		await Bun.sleep(600);

		expect(mockRepository.markAsFailedCalls).toHaveLength(0);
		expect(mockRepository.markAsDeadCalls).toEqual([
			{ id: "rec-dead", attempts: maxAttempts - 1, countAttempt: true },
		]);
		const stored = mockRepository.getRecord("rec-dead");
		expect(stored?.status).toBe(OutboxStatus.DEAD);
		expect(stored?.attempts).toBe(maxAttempts);
	});

	it("should log a warning when markAsFailed misses the optimistic lock", async () => {
		const record = makeRecord("rec-failed-miss", 0);
		mockRepository.markAsFailedResult = false;
		mockProcessor.setError(new Error("NATS down"));
		queue.enqueue(record);

		await Bun.sleep(600);

		expect(mockRepository.markAsFailedCalls).toHaveLength(1);
		expect(mockLogger.logs).toContainEqual(
			expect.objectContaining({
				level: "warn",
				message:
					"Outbox record rec-failed-miss was not marked as FAILED: optimistic-lock miss (record changed concurrently)",
				extra: { recordId: "rec-failed-miss", attempts: 0 },
			}),
		);
	});

	it("should log a warning when markAsDead misses the optimistic lock", async () => {
		const record = makeRecord("rec-dead-miss", maxAttempts - 1);
		mockRepository.markAsDeadResult = false;
		mockProcessor.setError(new Error("NATS down"));
		queue.enqueue(record);

		await Bun.sleep(600);

		expect(mockRepository.markAsDeadCalls).toHaveLength(1);
		expect(mockLogger.logs).toContainEqual(
			expect.objectContaining({
				level: "warn",
				message:
					"Outbox record rec-dead-miss was not marked as DEAD: optimistic-lock miss (record changed concurrently)",
				extra: { recordId: "rec-dead-miss", attempts: maxAttempts - 1 },
			}),
		);
	});

	it("should not call markAsFailed if a retry eventually succeeds", async () => {
		let callCount = 0;
		mockProcessor.setCustomBehavior(() => {
			callCount++;
			if (callCount < 2) throw new Error("transient");
		});

		queue.enqueue(makeRecord("rec-5"));

		await Bun.sleep(300);

		expect(mockRepository.markAsFailedCalls).toHaveLength(0);
		expect(mockProcessor.processInsertsCalls).toHaveLength(2);
	});

	it("should not fire pending retries after stop() is called", async () => {
		mockProcessor.setError(new Error("NATS down"));
		queue.enqueue(makeRecord("rec-6"));
		queue.stop();

		await Bun.sleep(300);

		expect(mockProcessor.processInsertsCalls).toHaveLength(0);
	});
});
