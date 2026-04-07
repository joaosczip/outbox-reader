import { beforeEach, describe, expect, it, mock } from "bun:test";
import { BATCH_SIZE, run } from "../src/cronjobs/reprocess-failed-events";
import type { OutboxRepository, OutboxRow } from "../src/outbox-repository";

const makeRow = (id: string): OutboxRow => ({
	id,
	aggregate_id: `agg-${id}`,
	aggregate_type: "User",
	event_type: "user.created",
	payload: {},
	sequence_number: 1,
	created_at: new Date().toISOString(),
	processed_at: null,
	status: "FAILED",
	attempts: 1,
});

const makeRows = (count: number, offset = 0): OutboxRow[] =>
	Array.from({ length: count }, (_, i) => makeRow(String(i + offset)));

const makeRepository = (findFailedEventsResponses: OutboxRow[][]): OutboxRepository => {
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
	} as unknown as OutboxRepository;

	return repo;
};

describe("reprocess-failed-events", () => {
	describe("when there are no failed events", () => {
		it("does not call onTransaction", async () => {
			const repo = makeRepository([[]]);

			await run(repo);

			expect(repo.onTransaction).not.toHaveBeenCalled();
		});

		it("calls findFailedEvents once", async () => {
			const repo = makeRepository([[]]);

			await run(repo);

			expect(repo.findFailedEvents).toHaveBeenCalledTimes(1);
		});
	});

	describe("when there are fewer events than BATCH_SIZE", () => {
		it("processes them in a single batch", async () => {
			const rows = makeRows(5);
			const repo = makeRepository([rows, []]);

			await run(repo);

			expect(repo.findFailedEvents).toHaveBeenCalledTimes(2);
			expect(repo.onTransaction).toHaveBeenCalledTimes(1);
		});

		it("deletes each event and re-creates it as PENDING", async () => {
			const rows = makeRows(2);
			const repo = makeRepository([rows, []]);

			await run(repo);

			expect(repo.delete).toHaveBeenCalledTimes(2);
			expect(repo.create).toHaveBeenCalledTimes(2);

			for (const row of rows) {
				expect(repo.delete).toHaveBeenCalledWith(row.id, "FAILED");
				expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ id: row.id, status: "PENDING" }));
			}
		});
	});

	describe("when there are more events than BATCH_SIZE", () => {
		it("calls findFailedEvents multiple times until empty", async () => {
			const batch1 = makeRows(BATCH_SIZE);
			const batch2 = makeRows(50, BATCH_SIZE);
			const repo = makeRepository([batch1, batch2, []]);

			await run(repo);

			expect(repo.findFailedEvents).toHaveBeenCalledTimes(3);
			expect(repo.onTransaction).toHaveBeenCalledTimes(2);
		});

		it("processes all events across batches", async () => {
			const batch1 = makeRows(BATCH_SIZE);
			const batch2 = makeRows(30, BATCH_SIZE);
			const repo = makeRepository([batch1, batch2, []]);

			await run(repo);

			expect(repo.delete).toHaveBeenCalledTimes(BATCH_SIZE + 30);
			expect(repo.create).toHaveBeenCalledTimes(BATCH_SIZE + 30);
		});

		it("passes BATCH_SIZE as the limit to findFailedEvents", async () => {
			const repo = makeRepository([[]]);

			await run(repo);

			expect(repo.findFailedEvents).toHaveBeenCalledWith(BATCH_SIZE);
		});
	});
});
