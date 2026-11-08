import type { Logger } from "./logger";
import type { OutboxRecord } from "./models/outbox-record";
import type { OutboxProcessor, ProcessInsertsResult } from "./outbox-processor";
import type { OutboxRepository } from "./outbox-repository";
import type { Publisher } from "./types";

export interface SuccessorDrainDeps {
	aggregateId: string;
	processor: Pick<OutboxProcessor, "processInserts">;
	repository: Pick<OutboxRepository, "findNextReadyPending">;
	publisher: Publisher;
	retryQueue: { enqueue(record: OutboxRecord): void };
	logger: Pick<Logger, "error">;
	/**
	 * Ids this drain published or retired. The WAL handler skips them so a successor
	 * already handled in this turn is not published again from a stale prefetch.
	 */
	handledIds?: Set<string>;
}

/**
 * Publishes ready successors of one aggregate: the oldest PENDING row that has no
 * older PENDING or FAILED sibling. Stops on `blocked` or when a successor throws
 * (that head is enqueued; a merely blocked row is not). Runs inside the caller's
 * sequencer turn — it must not call the sequencer again for this aggregate.
 *
 * DEAD siblings do not block, so once the head is DEAD this can publish the tail.
 * A long drain holds only this aggregate.
 */
export async function drainReadySuccessors({
	aggregateId,
	processor,
	repository,
	publisher,
	retryQueue,
	logger,
	handledIds,
}: SuccessorDrainDeps): Promise<void> {
	const seen = new Set<string>();

	for (;;) {
		const next = await repository.findNextReadyPending(aggregateId);
		const id = next?.id;
		if (!next || !id || seen.has(id)) return;
		seen.add(id);

		let outcome: ProcessInsertsResult;
		try {
			outcome = await processor.processInserts({
				insertedRecord: next,
				publisher,
				prefetchedOutbox: undefined,
			});
		} catch (error) {
			logger.error({
				message: `Outbox record ${id} failed while draining aggregate ${aggregateId}, enqueueing for retry`,
				extra: { recordId: id, aggregateId },
				error,
			});
			retryQueue.enqueue(next);
			return;
		}

		// blocked: an older PENDING/FAILED sibling is still ahead. Leave the tail PENDING.
		// lock_miss: the row is still unprocessed and would be selected again.
		if (outcome === "blocked" || outcome === "lock_miss") return;
		if (outcome === "published" || outcome === "dead" || outcome === "already_processed") {
			handledIds?.add(id);
			continue;
		}
		return;
	}
}
