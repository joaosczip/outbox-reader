import type { Wal2Json } from "pg-logical-replication";
import type { Logger } from "./logger";
import { processingDuration, recordsFiltered, walEventsReceived } from "./metrics";
import type { OutboxRecord } from "./models/outbox-record";
import type { OutboxProcessor } from "./outbox-processor";
import type { OutboxRepository } from "./outbox-repository";
import type { RetryQueue } from "./retry-queue";
import type { Publisher } from "./types";
import { runOrderedByKey } from "./utils/run-ordered-by-key";

export interface WalChangeHandlerMetrics {
	walEventsReceived: { add(value: number): void };
	recordsFiltered: { add(value: number): void };
	processingDuration: { record(value: number, attributes?: Record<string, string>): void };
}

export interface WalChangeHandlerDeps {
	processor: Pick<OutboxProcessor, "filterChanges" | "processInserts">;
	repository: Pick<OutboxRepository, "findUnprocessedByIds">;
	publisher: Publisher;
	retryQueue: Pick<RetryQueue, "enqueue">;
	logger: Pick<Logger, "error">;
	/** Maximum number of aggregates processed in parallel (typically the DB pool size). */
	concurrency: number;
	/** Defaults to the OpenTelemetry instruments from ./metrics. */
	metrics?: WalChangeHandlerMetrics;
}

const defaultMetrics: WalChangeHandlerMetrics = { walEventsReceived, recordsFiltered, processingDuration };

/**
 * Builds the `onChange` callback for `startReplication`.
 *
 * Contract with replication.ts (manual LSN ack):
 * - Resolves once every outbox insert of the WAL message was published or handed to the
 *   RetryQueue → the LSN may be acknowledged.
 * - Rejects only on batch-level failures (e.g. the prefetch query failing) → the LSN is
 *   NOT acknowledged and `onError` fires; the app must then exit so the stream restarts
 *   from the last confirmed LSN.
 *
 * Records are processed sequentially per `aggregateId` (in WAL order) and in parallel
 * across aggregates, with at most `concurrency` aggregates in flight.
 */
export const createWalChangeHandler = ({
	processor,
	repository,
	publisher,
	retryQueue,
	logger,
	concurrency,
	metrics = defaultMetrics,
}: WalChangeHandlerDeps): ((log: Wal2Json.Output) => Promise<void>) => {
	const processRecord = async (record: OutboxRecord, prefetched: Map<string, OutboxRecord>) => {
		const start = Date.now();
		try {
			await processor.processInserts({
				insertedRecord: record,
				prefetchedOutbox: prefetched.get(record.id as string) ?? null,
				publisher,
			});
		} catch (error) {
			logger.error({
				message: `Outbox record ${record.id} failed on first attempt, enqueueing for retry`,
				extra: { recordId: record.id },
				error,
			});
			retryQueue.enqueue(record);
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

		// processRecord never rejects, so runOrderedByKey only rejects on programming errors.
		await runOrderedByKey(
			outboxRecords,
			(record) => record.aggregateId,
			(record) => processRecord(record, prefetched),
			{ concurrency },
		);
	};
};
