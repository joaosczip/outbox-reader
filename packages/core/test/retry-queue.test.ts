import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from "bun:test";
import { retryQueueSize } from "../src/metrics";
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

/** Lets pending promise continuations (processInserts resolution, finally handlers) run. */
async function flushMicrotasks(rounds = 20): Promise<void> {
	for (let i = 0; i < rounds; i++) await Promise.resolve();
}

type Deferred = { resolve: () => void; reject: (e: Error) => void };

describe("RetryQueue under failure storms (bounded concurrency)", () => {
	const concurrency = 3;
	const totalRecords = 10;
	const stormConfig: RetryConfig = { jitter: "none", maxDelayInMs: 1000, numOfAttempts: 3, startingDelayInMs: 100 };

	let queue: RetryQueue;
	let mockProcessor: MockOutboxProcessor;
	let mockRepository: MockOutboxRepository;
	let inFlight: number;
	let maxInFlight: number;
	let deferreds: Deferred[];
	let queueSizeDelta: number;
	let queueSizeSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		jest.useFakeTimers();
		inFlight = 0;
		maxInFlight = 0;
		deferreds = [];
		queueSizeDelta = 0;
		queueSizeSpy = spyOn(retryQueueSize, "add").mockImplementation((value: number) => {
			queueSizeDelta += value;
		});

		mockProcessor = new MockOutboxProcessor();
		mockRepository = new MockOutboxRepository();
		mockProcessor.setCustomBehavior(
			() =>
				new Promise<void>((resolve, reject) => {
					inFlight++;
					maxInFlight = Math.max(maxInFlight, inFlight);
					deferreds.push({
						resolve: () => {
							inFlight--;
							resolve();
						},
						reject: (e) => {
							inFlight--;
							reject(e);
						},
					});
				}),
		);
		queue = new RetryQueue({
			processor: mockProcessor,
			publisher: new MockPublisher(),
			outboxRepository: mockRepository,
			logger: new MockLogger(),
			config: stormConfig,
			maxAttempts: 5,
			concurrency,
		});
	});

	afterEach(() => {
		queue.stop();
		queueSizeSpy.mockRestore();
		jest.useRealTimers();
	});

	function enqueueAll(): void {
		for (let i = 0; i < totalRecords; i++) queue.enqueue(makeRecord(`storm-${i}`));
	}

	async function settleNext(count: number, outcome: "resolve" | "reject" = "resolve"): Promise<void> {
		const batch = deferreds.splice(0, count);
		for (const d of batch) outcome === "resolve" ? d.resolve() : d.reject(new Error("NATS down"));
		await flushMicrotasks();
	}

	it("runs at most `concurrency` retries at once and eventually runs all of them, in FIFO order", async () => {
		enqueueAll();
		jest.advanceTimersByTime(100);
		await flushMicrotasks();

		expect(mockProcessor.processInsertsCalls).toHaveLength(concurrency);
		expect(inFlight).toBe(concurrency);
		expect(queue.stats()).toEqual({ scheduled: 0, queued: totalRecords - concurrency, inFlight: concurrency });

		while (deferreds.length > 0) {
			await settleNext(1);
			expect(inFlight).toBeLessThanOrEqual(concurrency);
		}

		expect(maxInFlight).toBe(concurrency);
		expect(mockProcessor.processInsertsCalls.map((c) => c.insertedRecord.id)).toEqual(
			Array.from({ length: totalRecords }, (_, i) => `storm-${i}`),
		);
		expect(queue.stats()).toEqual({ scheduled: 0, queued: 0, inFlight: 0 });
		expect(queueSizeDelta).toBe(0);
	});

	it("keeps the concurrency bound across failed attempts that are rescheduled", async () => {
		enqueueAll();
		jest.advanceTimersByTime(100);
		await flushMicrotasks();

		// Fail every first attempt; they get rescheduled with a 200ms delay.
		while (deferreds.length > 0) await settleNext(1, "reject");
		expect(mockProcessor.processInsertsCalls).toHaveLength(totalRecords);
		expect(queue.stats()).toEqual({ scheduled: totalRecords, queued: 0, inFlight: 0 });

		jest.advanceTimersByTime(200);
		await flushMicrotasks();
		expect(inFlight).toBe(concurrency);

		while (deferreds.length > 0) await settleNext(1);

		expect(maxInFlight).toBe(concurrency);
		expect(mockProcessor.processInsertsCalls).toHaveLength(totalRecords * 2);
		expect(mockRepository.markAsFailedCalls).toHaveLength(0);
		expect(queueSizeDelta).toBe(0);
	});

	it("cleans up timer bookkeeping after timers fire (no leak)", async () => {
		enqueueAll();
		expect(queue.stats().scheduled).toBe(totalRecords);
		expect(jest.getTimerCount()).toBe(totalRecords);

		jest.advanceTimersByTime(100);
		await flushMicrotasks();

		expect(queue.stats().scheduled).toBe(0);
		expect(jest.getTimerCount()).toBe(0);
	});

	it("stop() discards queued-but-not-started retries and pending timers", async () => {
		enqueueAll();
		jest.advanceTimersByTime(100);
		await flushMicrotasks();
		queue.enqueue(makeRecord("late")); // still waiting on its timer

		queue.stop();
		expect(queue.stats()).toEqual({ scheduled: 0, queued: 0, inFlight: concurrency });
		expect(jest.getTimerCount()).toBe(0);

		// In-flight retries finish (one fails); nothing new must start or be rescheduled.
		await settleNext(concurrency - 1);
		await settleNext(1, "reject");
		jest.advanceTimersByTime(10_000);
		await flushMicrotasks();

		expect(mockProcessor.processInsertsCalls).toHaveLength(concurrency);
		expect(queue.stats()).toEqual({ scheduled: 0, queued: 0, inFlight: 0 });
		expect(jest.getTimerCount()).toBe(0);
		expect(queueSizeDelta).toBe(0);
	});

	it("ignores records enqueued after stop()", () => {
		queue.stop();
		queue.enqueue(makeRecord("after-stop"));

		expect(queue.stats()).toEqual({ scheduled: 0, queued: 0, inFlight: 0 });
		expect(jest.getTimerCount()).toBe(0);
		expect(queueSizeDelta).toBe(0);
	});

	it("rejects an invalid concurrency", () => {
		expect(
			() =>
				new RetryQueue({
					processor: mockProcessor,
					publisher: new MockPublisher(),
					outboxRepository: mockRepository,
					logger: new MockLogger(),
					config: stormConfig,
					maxAttempts: 5,
					concurrency: 0,
				}),
		).toThrow(RangeError);
	});
});
