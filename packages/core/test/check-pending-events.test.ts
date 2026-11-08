import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DEFAULT_BATCH_SIZE, DEFAULT_CONCURRENCY, run } from "../src/cronjobs/check-pending-events";
import { OutboxRecord, OutboxStatus } from "../src/models/outbox-record";
import { MockLogger } from "./mocks/mock-logger";
import { MockOutboxProcessor } from "./mocks/mock-outbox-processor";
import { MockOutboxRepository } from "./mocks/mock-outbox-repository";
import { MockPublisher } from "./mocks/mock-publisher";

const makeRecord = (id: string, minutesAgo: number, attempts = 0): OutboxRecord =>
	new OutboxRecord({
		id,
		aggregateId: `agg-${id}`,
		aggregateType: "Order",
		eventType: "order.created",
		payload: { id },
		status: OutboxStatus.PENDING,
		attempts,
		createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
	});

describe("check-pending-events (stale PENDING sweeper)", () => {
	let repository: MockOutboxRepository;
	let processor: MockOutboxProcessor;
	let publisher: MockPublisher;
	let logger: MockLogger;

	/** Default processor behavior: publish and mark PROCESSED, like the real OutboxProcessor. */
	const succeed = async ({ insertedRecord }: { insertedRecord: OutboxRecord }) => {
		const id = insertedRecord.id as string;
		const fresh = await repository.findUnprocessedById(id);
		if (!fresh || fresh.status === OutboxStatus.PROCESSED) return;
		const seq = await publisher.publish({ record: fresh });
		await repository.markAsProcessed({ id, sequenceNumber: seq, attempts: fresh.attempts });
	};

	const sweep = (overrides: { thresholdMinutes?: number; batchSize?: number } = {}) =>
		run({
			repository,
			processor,
			publisher,
			logger,
			thresholdMinutes: overrides.thresholdMinutes ?? 10,
			batchSize: overrides.batchSize ?? 100,
		});

	beforeEach(() => {
		repository = new MockOutboxRepository();
		processor = new MockOutboxProcessor();
		publisher = new MockPublisher();
		logger = new MockLogger();
		processor.setCustomBehavior(succeed);
	});

	afterEach(() => {
		repository.reset();
		processor.reset();
		publisher.reset();
	});

	it("returns an empty summary and touches nothing when there are no stale events", async () => {
		const summary = await sweep();

		expect(summary).toEqual({ scanned: 0, republished: 0, failed: 0 });
		expect(processor.processInsertsCalls).toHaveLength(0);
		expect(publisher.publishCalls).toHaveLength(0);
		expect(repository.markAsFailedCalls).toHaveLength(0);
	});

	it("queries stale events with the configured threshold and batch size", async () => {
		await sweep({ thresholdMinutes: 25, batchSize: 7 });

		expect(repository.findStalePendingEventsCalls[0]).toEqual({ olderThanMinutes: 25, limit: 7 });
	});

	it("uses the default batch size constant when none is given", async () => {
		await run({ repository, processor, publisher, logger, thresholdMinutes: 10 });

		expect(repository.findStalePendingEventsCalls[0]).toEqual({ olderThanMinutes: 10, limit: DEFAULT_BATCH_SIZE });
	});

	it("sends every stale record through the processor with the configured publisher and a fresh DB read", async () => {
		const records = [makeRecord("a", 30), makeRecord("b", 20), makeRecord("c", 15)];
		for (const r of records) repository.addRecord(r);

		const summary = await sweep();

		expect(processor.processInsertsCalls.map((c) => c.insertedRecord.id)).toEqual(["a", "b", "c"]);
		for (const call of processor.processInsertsCalls) {
			expect(call.publisher).toBe(publisher);
			expect(call.prefetchedOutbox).toBeUndefined();
			expect("prefetchedOutbox" in call).toBe(true);
		}
		expect(publisher.publishCalls.map((c) => c.record.id)).toEqual(["a", "b", "c"]);
		expect(repository.markAsProcessedCalls.map((c) => c.id)).toEqual(["a", "b", "c"]);
		for (const r of records) expect(repository.getRecord(r.id as string)?.status).toBe(OutboxStatus.PROCESSED);
		expect(repository.markAsFailedCalls).toHaveLength(0);
		expect(summary).toEqual({ scanned: 3, republished: 3, failed: 0 });
	});

	it("does not stop on a failing record and marks it FAILED with its current attempts", async () => {
		repository.addRecord(makeRecord("a", 30));
		repository.addRecord(makeRecord("b", 20, 2));
		repository.addRecord(makeRecord("c", 15));
		const boom = new Error("publish failed");
		processor.setCustomBehavior(async (params) => {
			if (params.insertedRecord.id === "b") throw boom;
			await succeed(params);
		});

		const summary = await sweep();

		expect(processor.processInsertsCalls.map((c) => c.insertedRecord.id)).toEqual(["a", "b", "c"]);
		expect(repository.markAsFailedCalls).toEqual([{ id: "b", attempts: 2 }]);
		expect(repository.getRecord("b")?.status).toBe(OutboxStatus.FAILED);
		expect(repository.getRecord("a")?.status).toBe(OutboxStatus.PROCESSED);
		expect(repository.getRecord("c")?.status).toBe(OutboxStatus.PROCESSED);
		expect(summary).toEqual({ scanned: 3, republished: 2, failed: 1 });

		const errorLog = logger.logs.find((l) => l.level === "error");
		expect(errorLog?.error).toBe(boom);
		expect(errorLog?.extra).toMatchObject({ id: "b" });
	});

	it("keeps going when marking a record as FAILED itself throws", async () => {
		repository.addRecord(makeRecord("a", 30));
		repository.addRecord(makeRecord("b", 20));
		processor.setCustomBehavior(async (params) => {
			if (params.insertedRecord.id === "a") throw new Error("publish failed");
			await succeed(params);
		});
		repository.markAsFailed = async () => {
			throw new Error("db down");
		};

		const summary = await sweep();

		expect(processor.processInsertsCalls.map((c) => c.insertedRecord.id)).toEqual(["a", "b"]);
		expect(repository.getRecord("b")?.status).toBe(OutboxStatus.PROCESSED);
		expect(summary).toEqual({ scanned: 2, republished: 1, failed: 1 });
	});

	it("processes stale records across multiple batches", async () => {
		for (let i = 0; i < 5; i++) repository.addRecord(makeRecord(`r${i}`, 60 - i));

		const summary = await sweep({ batchSize: 2 });

		expect(processor.processInsertsCalls.map((c) => c.insertedRecord.id)).toEqual(["r0", "r1", "r2", "r3", "r4"]);
		expect(repository.findStalePendingEventsCalls.length).toBeGreaterThanOrEqual(3);
		expect(summary).toEqual({ scanned: 5, republished: 5, failed: 0 });
	});

	it("terminates and never re-processes a record whose status the processor leaves PENDING", async () => {
		// e.g. the processor skips it (max attempts reached) without changing its status
		for (let i = 0; i < 3; i++) repository.addRecord(makeRecord(`r${i}`, 60 - i));
		processor.setCustomBehavior(async () => {});

		const summary = await sweep({ batchSize: 2 });

		const ids = processor.processInsertsCalls.map((c) => c.insertedRecord.id);
		expect(ids).toEqual([...new Set(ids)]);
		expect(repository.findStalePendingEventsCalls.length).toBeLessThan(5);
		expect(summary.scanned).toBe(ids.length);
	});

	describe("concurrency (records processed in parallel across aggregates)", () => {
		const recordFor = (id: string, aggregateId: string, minutesAgo: number) =>
			new OutboxRecord({ ...makeRecord(id, minutesAgo), aggregateId });

		/** Tracks start/end of every processInserts call and the peak number of calls in flight. */
		const track = (delayMs: (id: string) => number = () => 5, fail: (id: string) => boolean = () => false) => {
			const events: string[] = [];
			let inFlight = 0;
			const peak = { value: 0 };
			processor.setCustomBehavior(async (params) => {
				const id = params.insertedRecord.id as string;
				events.push(`start:${id}`);
				inFlight++;
				peak.value = Math.max(peak.value, inFlight);
				await new Promise((resolve) => setTimeout(resolve, delayMs(id)));
				inFlight--;
				events.push(`end:${id}`);
				if (fail(id)) throw new Error(`publish failed for ${id}`);
				await succeed(params);
			});
			return { events, peak };
		};

		it("keeps records of the same aggregate strictly sequential and in query order", async () => {
			// a1 is slow: a2 must still wait for it, while the B records run alongside.
			repository.addRecord(recordFor("a1", "A", 50));
			repository.addRecord(recordFor("b1", "B", 49));
			repository.addRecord(recordFor("a2", "A", 48));
			repository.addRecord(recordFor("b2", "B", 47));
			repository.addRecord(recordFor("a3", "A", 46));
			const { events } = track((id) => (id === "a1" ? 30 : 2));

			await sweep();

			const forAggregate = (prefix: string) => events.filter((e) => e.split(":")[1].startsWith(prefix));
			expect(forAggregate("a")).toEqual(["start:a1", "end:a1", "start:a2", "end:a2", "start:a3", "end:a3"]);
			expect(forAggregate("b")).toEqual(["start:b1", "end:b1", "start:b2", "end:b2"]);
			// B finished while the slow a1 was still in flight: aggregates ran in parallel.
			expect(events.indexOf("end:b2")).toBeLessThan(events.indexOf("end:a1"));
		});

		it("runs different aggregates concurrently up to the configured limit", async () => {
			for (let i = 0; i < 6; i++) repository.addRecord(recordFor(`r${i}`, `agg-${i}`, 60 - i));
			const { peak } = track();

			const summary = await run({
				repository,
				processor,
				publisher,
				logger,
				thresholdMinutes: 10,
				concurrency: 2,
			});

			expect(peak.value).toBe(2);
			expect(summary).toEqual({ scanned: 6, republished: 6, failed: 0 });
		});

		it("processes up to DEFAULT_CONCURRENCY aggregates in parallel by default", async () => {
			for (let i = 0; i < DEFAULT_CONCURRENCY + 5; i++)
				repository.addRecord(recordFor(`r${i}`, `agg-${i}`, 60 - i));
			const { peak } = track();

			await run({ repository, processor, publisher, logger, thresholdMinutes: 10 });

			expect(peak.value).toBe(DEFAULT_CONCURRENCY);
		});

		it("processes one record at a time with concurrency 1", async () => {
			for (let i = 0; i < 4; i++) repository.addRecord(recordFor(`r${i}`, `agg-${i}`, 60 - i));
			const { peak } = track();

			await run({ repository, processor, publisher, logger, thresholdMinutes: 10, concurrency: 1 });

			expect(peak.value).toBe(1);
		});

		it("keeps the summary correct with mixed success and failure under concurrency", async () => {
			const ids = ["a1", "b1", "a2", "c1", "b2", "c2", "d1"];
			ids.forEach((id, i) => repository.addRecord(recordFor(id, id[0].toUpperCase(), 60 - i)));
			const failing = new Set(["a1", "b2", "c1"]);
			track(
				(id) => (id.charCodeAt(0) % 3) + 1,
				(id) => failing.has(id),
			);

			const summary = await run({
				repository,
				processor,
				publisher,
				logger,
				thresholdMinutes: 10,
				batchSize: 3,
				concurrency: 3,
			});

			expect(summary).toEqual({ scanned: 7, republished: 4, failed: 3 });
			expect(repository.markAsFailedCalls.map((c) => c.id).sort()).toEqual(["a1", "b2", "c1"]);
			expect(processor.processInsertsCalls.map((c) => c.insertedRecord.id).sort()).toEqual([...ids].sort());
			for (const id of ids) {
				expect(repository.getRecord(id)?.status).toBe(
					failing.has(id) ? OutboxStatus.FAILED : OutboxStatus.PROCESSED,
				);
			}
		});

		it("rejects an invalid concurrency", async () => {
			repository.addRecord(makeRecord("a", 30));

			await expect(
				run({ repository, processor, publisher, logger, thresholdMinutes: 10, concurrency: 0 }),
			).rejects.toThrow(RangeError);
		});
	});

	it("does not close the publisher it was given (the caller owns its lifecycle)", async () => {
		repository.addRecord(makeRecord("a", 30));

		await sweep();

		expect(publisher.closeCalls).toBe(0);
	});
});
