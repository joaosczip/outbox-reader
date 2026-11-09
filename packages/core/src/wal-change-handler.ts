import type { Wal2Json } from "pg-logical-replication";
import type { Logger } from "./logger";
import { processingDuration, recordsFiltered, walEventsReceived } from "./metrics";
import type { OutboxRecord } from "./models/outbox-record";
import type { OutboxProcessor } from "./outbox-processor";
import type { OutboxRepository } from "./outbox-repository";
import type { RetryQueue } from "./retry-queue";
import { drainReadySuccessors } from "./successor-drain";
import type { Publisher } from "./types";
import { AggregateSequencer } from "./utils/aggregate-sequencer";
import { runOrderedByKey } from "./utils/run-ordered-by-key";

export interface WalChangeHandlerMetrics {
	walEventsReceived: { add(value: number): void };
	recordsFiltered: { add(value: number): void };
	processingDuration: { record(value: number, attributes?: Record<string, string>): void };
}

export interface WalChangeHandlerDeps {
	processor: Pick<OutboxProcessor, "filterChanges" | "processInserts">;
	repository: Pick<OutboxRepository, "findUnprocessedByIds" | "findNextReadyPending">;
	publisher: Publisher;
	retryQueue: Pick<RetryQueue, "enqueue">;
	logger: Pick<Logger, "error">;
	/** Maximum number of aggregates processed in parallel (typically the DB pool size). */
	concurrency: number;
	/**
	 * Shared with the RetryQueue so one process never publishes the same aggregate from
	 * both paths at once. A fresh chain is used when omitted (tests that do not share it).
	 */
	sequencer?: AggregateSequencer;
	/** Defaults to the OpenTelemetry instruments from ./metrics. */
	metrics?: WalChangeHandlerMetrics;
}

const defaultMetrics: WalChangeHandlerMetrics = { walEventsReceived, recordsFiltered, processingDuration };

/**
 * Builds the `onChange` callback for `startReplication`.
 *
 * Contract with replication.ts (manual LSN ack):
 * - Resolves once every outbox insert of the WAL message was published, blocked, or handed
 *   to the RetryQueue → the LSN may be acknowledged.
 * - Rejects only on batch-level failures (e.g. the prefetch query failing) → the LSN is
 *   NOT acknowledged and `onError` fires; the app must then exit so the stream restarts
 *   from the last confirmed LSN.
 *
 * Within one aggregate, events are published in `(created_at, id)` order. A publish throw
 * enqueues that head only: later siblings stay PENDING (they are not published and not
 * enqueued as failures) and are released by the drain when the head is published or marked
 * DEAD. Different aggregates stay parallel, bounded by `concurrency`.
 */
export const createWalChangeHandler = ({
	processor,
	repository,
	publisher,
	retryQueue,
	logger,
	concurrency,
	sequencer = new AggregateSequencer(),
	metrics = defaultMetrics,
}: WalChangeHandlerDeps): ((log: Wal2Json.Output) => Promise<void>) => {
	const processRecord = async (
		record: OutboxRecord,
		prefetched: Map<string, OutboxRecord>,
		halted: Set<string>,
		handledIds: Set<string>,
	) => {
		const start = Date.now();
		try {
			const outcome = await processor.processInserts({
				insertedRecord: record,
				prefetchedOutbox: prefetched.get(record.id as string) ?? null,
				publisher,
			});
			if (outcome === "published" || outcome === "dead") {
				await drainReadySuccessors({
					aggregateId: record.aggregateId,
					processor,
					repository,
					publisher,
					retryQueue,
					logger,
					handledIds,
				});
			}
		} catch (error) {
			logger.error({
				message: `Outbox record ${record.id} failed on first attempt, enqueueing for retry`,
				extra: { recordId: record.id },
				error,
			});
			retryQueue.enqueue(record);
			// Later siblings stay PENDING. They are not enqueued as failures; the drain
			// publishes them when this head succeeds or becomes DEAD.
			halted.add(record.aggregateId);
		} finally {
			metrics.processingDuration.record(Date.now() - start, { "event.type": record.eventType });
		}
	};

	return async (log: Wal2Json.Output): Promise<void> => {
		metrics.walEventsReceived.add(1);

		const outboxRecords = processor.filterChanges(log);
		metrics.recordsFiltered.add(outboxRecords.length);
		if (outboxRecords.length === 0) return;

		// A failure here must propagate: the LSN must not be acked or the records stay PENDING forever.
		const fetchedRecords = await repository.findUnprocessedByIds(outboxRecords.map((r) => r.id as string));
		const prefetched = new Map(fetchedRecords.map((r) => [r.id as string, r]));
		const halted = new Set<string>();
		const handledIds = new Set<string>();

		// processRecord never rejects, so runOrderedByKey only rejects on programming errors.
		await runOrderedByKey(
			outboxRecords,
			(record) => record.aggregateId,
			(record) => {
				if (halted.has(record.aggregateId) || handledIds.has(record.id as string)) return Promise.resolve();
				return sequencer.run(record.aggregateId, () => processRecord(record, prefetched, halted, handledIds));
			},
			{ concurrency },
		);
	};
};
