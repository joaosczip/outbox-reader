import { beforeEach, describe, expect, it, mock } from "bun:test";
import { BATCH_SIZE, run } from "../src/cronjobs/reprocess-failed-events";
import { OutboxRecord, OutboxStatus } from "../src/models/outbox-record";
import type { OutboxRepository } from "../src/outbox-repository";

const MAX_ATTEMPTS = 5;
const options = { maxAttempts: MAX_ATTEMPTS };

const makeRow = (id: string, attempts = 1): OutboxRecord =>
	new OutboxRecord({
		id,
		aggregateId: `agg-${id}`,
		aggregateType: "User",
		eventType: "user.created",
		payload: { n: id },
		sequenceNumber: 1,
		status: OutboxStatus.FAILED,
		attempts,
	});

const makeRows = (count: number, offset = 0): OutboxRecord[] =>
	Array.from({ length: count }, (_, i) => makeRow(String(i + offset)));

const makeRepository = (findFailedEventsResponses: OutboxRecord[][]): OutboxRepository => {
	let call = 0;
	const deleteCalls: Array<[string, string]> = [];
	const createCalls: unknown[] = [];

	const repo = {
		findFailedEvents: mock(async (_limit = 100) => {
			return findFailedEventsResponses[call++] ?? [];
		}),
		onTransaction: mock(async (callback: (tx: OutboxRepository) => Promise<void>) => {
			await callback(repo as unknown as OutboxRepository);
		}),
		delete: mock(async (id: string, status: string) => {
			deleteCalls.push([id, status]);
		}),
		create: mock(async (params: unknown) => {
			createCalls.push(params);
			return "new-id";
		}),
		markAsDead: mock(async (_params: unknown) => true),
	} as unknown as OutboxRepository;

	return repo;
};

/**
 * Stateful in-memory repository: findFailedEvents only returns rows whose status is FAILED,
 * so it reflects the effect of delete/create/markAsDead like the real table would.
 */
const makeStatefulRepository = (rows: OutboxRecord[], { markAsDeadResult = true } = {}) => {
	const store = new Map(rows.map((r) => [r.id as string, new OutboxRecord({ ...r, createdAt: undefined })]));

	const repo = {
		findFailedEvents: mock(async (limit = 100) =>
			[...store.values()].filter((r) => r.status === OutboxStatus.FAILED).slice(0, limit),
		),
		onTransaction: mock(async (callback: (tx: OutboxRepository) => Promise<void>) => {
			await callback(repo as unknown as OutboxRepository);
		}),
		delete: mock(async (id: string, status: string) => {
			if (store.get(id)?.status === status) store.delete(id);
		}),
		create: mock(async (params: { id: string; status: string } & Record<string, unknown>) => {
			store.set(params.id, new OutboxRecord(params as never));
			return params.id;
		}),
		markAsDead: mock(async ({ id, attempts }: { id: string; attempts: number }) => {
			const record = store.get(id);
			if (!markAsDeadResult || !record || record.attempts !== attempts) return false;
			record.status = OutboxStatus.DEAD;
			return true;
		}),
	};

	return { repo: repo as unknown as OutboxRepository, store };
};

describe("reprocess-failed-events", () => {
	describe("when there are no failed events", () => {
		it("does not call onTransaction", async () => {
			const repo = makeRepository([[]]);

			await run(repo, options);

			expect(repo.onTransaction).not.toHaveBeenCalled();
		});

		it("calls findFailedEvents once", async () => {
			const repo = makeRepository([[]]);

			await run(repo, options);

			expect(repo.findFailedEvents).toHaveBeenCalledTimes(1);
		});
	});

	describe("when there are fewer events than BATCH_SIZE", () => {
		it("processes them in a single batch", async () => {
			const rows = makeRows(5);
			const repo = makeRepository([rows, []]);

			await run(repo, options);

			expect(repo.findFailedEvents).toHaveBeenCalledTimes(2);
			expect(repo.onTransaction).toHaveBeenCalledTimes(1);
		});

		it("deletes each event and re-creates it as PENDING", async () => {
			const rows = makeRows(2);
			const repo = makeRepository([rows, []]);

			await run(repo, options);

			expect(repo.delete).toHaveBeenCalledTimes(2);
			expect(repo.create).toHaveBeenCalledTimes(2);

			for (const row of rows) {
				expect(repo.delete).toHaveBeenCalledWith(row.id, "FAILED");
				expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ id: row.id, status: "PENDING" }));
			}
		});

		it("re-creates every field from the mapped record (regression: snake_case keys were hardcoded)", async () => {
			const rows = [
				new OutboxRecord({
					id: "camel-1",
					aggregateId: "agg-camel",
					aggregateType: "Order",
					eventType: "order.placed",
					payload: { total: 10 },
					sequenceNumber: 42,
					status: OutboxStatus.FAILED,
					attempts: 3,
				}),
			];
			const repo = makeRepository([rows, []]);

			await run(repo, options);

			expect(repo.delete).toHaveBeenCalledWith("camel-1", "FAILED");
			expect(repo.create).toHaveBeenCalledTimes(1);
			expect(repo.create).toHaveBeenCalledWith({
				id: "camel-1",
				aggregateId: "agg-camel",
				aggregateType: "Order",
				eventType: "order.placed",
				payload: { total: 10 },
				sequenceNumber: 42,
				status: "PENDING",
				attempts: 3,
			});
		});
	});

	describe("when there are more events than BATCH_SIZE", () => {
		it("calls findFailedEvents multiple times until empty", async () => {
			const batch1 = makeRows(BATCH_SIZE);
			const batch2 = makeRows(50, BATCH_SIZE);
			const repo = makeRepository([batch1, batch2, []]);

			await run(repo, options);

			expect(repo.findFailedEvents).toHaveBeenCalledTimes(3);
			expect(repo.onTransaction).toHaveBeenCalledTimes(2);
		});

		it("processes all events across batches", async () => {
			const batch1 = makeRows(BATCH_SIZE);
			const batch2 = makeRows(30, BATCH_SIZE);
			const repo = makeRepository([batch1, batch2, []]);

			await run(repo, options);

			expect(repo.delete).toHaveBeenCalledTimes(BATCH_SIZE + 30);
			expect(repo.create).toHaveBeenCalledTimes(BATCH_SIZE + 30);
		});

		it("passes BATCH_SIZE as the limit to findFailedEvents", async () => {
			const repo = makeRepository([[]]);

			await run(repo, options);

			expect(repo.findFailedEvents).toHaveBeenCalledWith(BATCH_SIZE);
		});
	});

	describe("max attempts (regression: endless delete/insert loop)", () => {
		it("marks FAILED records that reached maxAttempts as DEAD instead of re-inserting them", async () => {
			const exhausted = makeRow("dead-1", MAX_ATTEMPTS);
			const over = makeRow("dead-2", MAX_ATTEMPTS + 2);
			const retryable = makeRow("retry-1", MAX_ATTEMPTS - 1);
			const { repo, store } = makeStatefulRepository([exhausted, over, retryable]);

			await run(repo, options);

			expect(repo.markAsDead).toHaveBeenCalledTimes(2);
			expect(repo.markAsDead).toHaveBeenCalledWith(
				expect.objectContaining({ id: "dead-1", attempts: MAX_ATTEMPTS }),
			);
			expect(repo.markAsDead).toHaveBeenCalledWith(
				expect.objectContaining({ id: "dead-2", attempts: MAX_ATTEMPTS + 2 }),
			);
			expect(repo.delete).toHaveBeenCalledTimes(1);
			expect(repo.delete).toHaveBeenCalledWith("retry-1", "FAILED");
			expect(repo.create).toHaveBeenCalledTimes(1);
			expect(repo.create).toHaveBeenCalledWith(
				expect.objectContaining({ id: "retry-1", status: "PENDING", attempts: MAX_ATTEMPTS - 1 }),
			);

			expect(store.get("dead-1")?.status).toBe(OutboxStatus.DEAD);
			expect(store.get("dead-2")?.status).toBe(OutboxStatus.DEAD);
			expect(store.get("retry-1")?.status).toBe(OutboxStatus.PENDING);
		});

		it("terminates once every FAILED record is either DEAD or re-inserted as PENDING", async () => {
			const rows = [
				...Array.from({ length: BATCH_SIZE }, (_, i) => makeRow(`d${i}`, MAX_ATTEMPTS)),
				...Array.from({ length: 30 }, (_, i) => makeRow(`r${i}`, 0)),
			];
			const { repo, store } = makeStatefulRepository(rows);

			await run(repo, options);

			expect(repo.findFailedEvents).toHaveBeenCalledTimes(3);
			expect(repo.markAsDead).toHaveBeenCalledTimes(BATCH_SIZE);
			expect(repo.create).toHaveBeenCalledTimes(30);
			expect([...store.values()].filter((r) => r.status === OutboxStatus.FAILED)).toHaveLength(0);
		});

		it("terminates even when marking DEAD misses the optimistic lock (records stay FAILED)", async () => {
			const rows = [makeRow("stuck-1", MAX_ATTEMPTS), makeRow("stuck-2", MAX_ATTEMPTS)];
			const { repo, store } = makeStatefulRepository(rows, { markAsDeadResult: false });

			await run(repo, options);

			expect(repo.findFailedEvents).toHaveBeenCalledTimes(2);
			expect(repo.markAsDead).toHaveBeenCalledTimes(2);
			expect(repo.create).not.toHaveBeenCalled();
			expect(store.get("stuck-1")?.status).toBe(OutboxStatus.FAILED);
		});
	});
});
