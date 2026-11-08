import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Wal2Json } from "pg-logical-replication";
import type { Logger } from "../src/logger";
import { OutboxRecord, OutboxStatus } from "../src/models/outbox-record";
import { OutboxProcessor } from "../src/outbox-processor";
import type { OutboxRepository } from "../src/outbox-repository";
import { type WalChangeHandlerMetrics, createWalChangeHandler } from "../src/wal-change-handler";
import { MockLogger } from "./mocks/mock-logger";
import { MockOutboxRepository } from "./mocks/mock-outbox-repository";
import { MockPublisher } from "./mocks/mock-publisher";
import { Wal2JsonTestHelper } from "./mocks/wal2json-helper";

type RecordSpec = { id: string; aggregateId: string; eventType?: string };

class FakeRetryQueue {
	public enqueued: OutboxRecord[] = [];
	enqueue(record: OutboxRecord): void {
		this.enqueued.push(record);
	}
}

/** Publisher whose publish() can be delayed per record and records start/end order. */
class TimedPublisher extends MockPublisher {
	public timeline: string[] = [];
	public delays = new Map<string, number>();
	public failingIds = new Set<string>();
	private inFlight = 0;
	public maxInFlight = 0;

	override async publish({ record }: { record: OutboxRecord }): Promise<number> {
		const id = record.id as string;
		this.timeline.push(`start:${id}`);
		this.inFlight++;
		this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
		try {
			await Bun.sleep(this.delays.get(id) ?? 0);
			if (this.failingIds.has(id)) throw new Error(`publish failed for ${id}`);
			return await super.publish({ record });
		} finally {
			this.inFlight--;
			this.timeline.push(`end:${id}`);
		}
	}
}

class RecordingMetrics implements WalChangeHandlerMetrics {
	public walEvents = 0;
	public filtered: number[] = [];
	public durations: Array<{ value: number; eventType: unknown }> = [];
	walEventsReceived = {
		add: (n: number) => {
			this.walEvents += n;
		},
	};
	recordsFiltered = {
		add: (n: number) => {
			this.filtered.push(n);
		},
	};
	processingDuration = {
		record: (value: number, attrs?: Record<string, unknown>) => {
			this.durations.push({ value, eventType: attrs?.["event.type"] });
		},
	};
}

const toWal = (specs: RecordSpec[], extra: Parameters<typeof Wal2JsonTestHelper.createMockOutput>[0] = []) =>
	Wal2JsonTestHelper.createMockOutput([
		...specs.map((s) =>
			Wal2JsonTestHelper.createOutboxInsert({
				id: s.id,
				aggregateId: s.aggregateId,
				aggregateType: "Order",
				eventType: s.eventType ?? "order.created",
			}),
		),
		...extra,
	]);

const pendingRecord = (s: RecordSpec) =>
	new OutboxRecord({
		id: s.id,
		aggregateId: s.aggregateId,
		aggregateType: "Order",
		eventType: s.eventType ?? "order.created",
		payload: {},
		status: OutboxStatus.PENDING,
		attempts: 0,
	});

describe("createWalChangeHandler", () => {
	let repository: MockOutboxRepository;
	let publisher: TimedPublisher;
	let retryQueue: FakeRetryQueue;
	let logger: MockLogger;
	let metrics: RecordingMetrics;
	let handler: (log: Wal2Json.Output) => Promise<void>;

	const seed = (specs: RecordSpec[]) => {
		for (const s of specs) repository.addRecord(pendingRecord(s));
	};

	beforeEach(() => {
		repository = new MockOutboxRepository();
		publisher = new TimedPublisher();
		retryQueue = new FakeRetryQueue();
		logger = new MockLogger();
		metrics = new RecordingMetrics();
		const processor = new OutboxProcessor({
			outboxRepository: repository as unknown as OutboxRepository,
			logger: logger as unknown as Logger,
			maxAttempts: 5,
		});
		handler = createWalChangeHandler({
			processor,
			repository,
			publisher,
			retryQueue,
			logger,
			concurrency: 4,
			metrics,
		});
	});

	afterEach(() => {
		repository.reset();
		publisher.reset();
	});

	it("rejects (so the LSN is not acked) when the prefetch query fails, without publishing or enqueueing", async () => {
		const specs = [{ id: "r1", aggregateId: "a1" }];
		seed(specs);
		const dbError = new Error("connection terminated");
		repository.findUnprocessedByIds = async () => {
			throw dbError;
		};

		await expect(handler(toWal(specs))).rejects.toBe(dbError);

		expect(publisher.publishCalls).toHaveLength(0);
		expect(repository.markAsProcessedCalls).toHaveLength(0);
		expect(retryQueue.enqueued).toHaveLength(0);
		// Records stay PENDING so a restart from the last confirmed LSN re-delivers them.
		expect(repository.getRecord("r1")?.status).toBe(OutboxStatus.PENDING);
	});

	it("enqueues a record whose publish fails for retry and still resolves, processing the rest", async () => {
		const specs = [
			{ id: "ok-1", aggregateId: "a1" },
			{ id: "bad", aggregateId: "a2", eventType: "order.paid" },
			{ id: "ok-2", aggregateId: "a3" },
		];
		seed(specs);
		publisher.failingIds.add("bad");

		await expect(handler(toWal(specs))).resolves.toBeUndefined();

		expect(retryQueue.enqueued.map((r) => r.id)).toEqual(["bad"]);
		expect(retryQueue.enqueued[0]?.aggregateId).toBe("a2");
		expect(repository.markAsProcessedCalls.map((c) => c.id).sort()).toEqual(["ok-1", "ok-2"]);
		expect(repository.getRecord("bad")?.status).toBe(OutboxStatus.PENDING);
		const errorLog = logger.logs.find((l) => l.level === "error");
		expect(errorLog?.message).toContain("bad");
		expect((errorLog?.error as Error).message).toBe("publish failed for bad");
		// processingDuration recorded for successes and the failure alike
		expect(metrics.durations.map((d) => d.eventType).sort()).toEqual([
			"order.created",
			"order.created",
			"order.paid",
		]);
		expect(metrics.walEvents).toBe(1);
		expect(metrics.filtered).toEqual([3]);
	});

	it("processes records of the same aggregate sequentially in WAL order and different aggregates concurrently", async () => {
		const specs = [
			{ id: "a1-e1", aggregateId: "a1" },
			{ id: "a2-e1", aggregateId: "a2" },
			{ id: "a1-e2", aggregateId: "a1" },
			{ id: "a1-e3", aggregateId: "a1" },
		];
		seed(specs);
		// The first event of a1 is the slowest: a naive parallel run would finish e2/e3 first.
		publisher.delays.set("a1-e1", 40);
		publisher.delays.set("a1-e2", 5);
		publisher.delays.set("a1-e3", 0);
		publisher.delays.set("a2-e1", 20);

		await handler(toWal(specs));

		const a1Timeline = publisher.timeline.filter((e) => e.includes("a1-"));
		expect(a1Timeline).toEqual([
			"start:a1-e1",
			"end:a1-e1",
			"start:a1-e2",
			"end:a1-e2",
			"start:a1-e3",
			"end:a1-e3",
		]);
		expect(publisher.publishedRecords.filter((r) => r.aggregateId === "a1").map((r) => r.id)).toEqual([
			"a1-e1",
			"a1-e2",
			"a1-e3",
		]);
		// a2 ran in parallel with a1's first event (started before a1-e1 finished).
		expect(publisher.timeline.indexOf("start:a2-e1")).toBeLessThan(publisher.timeline.indexOf("end:a1-e1"));
		expect(publisher.maxInFlight).toBe(2);
		expect(repository.markAsProcessedCalls).toHaveLength(4);
	});

	it("continues an aggregate's later events after an earlier one of that aggregate fails", async () => {
		const specs = [
			{ id: "a1-e1", aggregateId: "a1" },
			{ id: "a1-e2", aggregateId: "a1" },
		];
		seed(specs);
		publisher.failingIds.add("a1-e1");

		await expect(handler(toWal(specs))).resolves.toBeUndefined();

		expect(publisher.timeline).toEqual(["start:a1-e1", "end:a1-e1", "start:a1-e2", "end:a1-e2"]);
		expect(retryQueue.enqueued.map((r) => r.id)).toEqual(["a1-e1"]);
		expect(repository.markAsProcessedCalls.map((c) => c.id)).toEqual(["a1-e2"]);
	});

	it("prefetches all outbox ids of the batch in a single query", async () => {
		const specs = [
			{ id: "r1", aggregateId: "a1" },
			{ id: "r2", aggregateId: "a2" },
		];
		seed(specs);

		await handler(toWal(specs));

		expect(repository.findUnprocessedByIdsCalls).toEqual([["r1", "r2"]]);
		// processInserts used the prefetched rows instead of re-reading each record
		expect(repository.findUnprocessedByIdCalls).toHaveLength(0);
	});

	it("resolves without any DB call or publish when the WAL batch has no outbox inserts", async () => {
		const log = toWal(
			[],
			[
				{ kind: "insert", table: "orders", columnnames: ["id"], columnvalues: ["o1"] },
				{ kind: "update", table: "outbox", columnnames: ["id"], columnvalues: ["r1"] },
			],
		);

		await expect(handler(log)).resolves.toBeUndefined();

		expect(repository.findUnprocessedByIdsCalls).toHaveLength(0);
		expect(repository.findUnprocessedByIdCalls).toHaveLength(0);
		expect(publisher.publishCalls).toHaveLength(0);
		expect(retryQueue.enqueued).toHaveLength(0);
		expect(metrics.walEvents).toBe(1);
		expect(metrics.filtered).toEqual([0]);
	});
});
