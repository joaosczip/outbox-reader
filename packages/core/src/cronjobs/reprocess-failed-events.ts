import { getIntEnvOrDefault, loadCronConfig } from "../config";
import { Logger } from "../logger";
import { recordsDead } from "../metrics";
import type { OutboxRecord } from "../models/outbox-record";
import { OutboxRepository } from "../outbox-repository";

const logger = new Logger("outbox-reader:reprocess-failed-events");

export const BATCH_SIZE = 100;

export type ReprocessFailedEventsOptions = {
	/** FAILED records with `attempts >= maxAttempts` are marked DEAD instead of being re-inserted. */
	maxAttempts: number;
};

const eventLogExtra = (event: OutboxRecord) => ({
	id: event.id,
	aggregateId: event.aggregateId,
	eventType: event.eventType,
	attempts: event.attempts,
});

const markAsDead = async (tx: OutboxRepository, event: OutboxRecord, maxAttempts: number): Promise<boolean> => {
	const marked = await tx.markAsDead({
		id: event.id as string,
		attempts: event.attempts,
		retry: (error, attempts) => {
			logger.error({
				message: `Error marking failed event ${event.id} as dead`,
				extra: { ...eventLogExtra(event), retryAttempt: attempts },
				error,
			});
			return true;
		},
	});

	if (!marked) {
		logger.warn({
			message: `Failed event ${event.id} was not marked as DEAD: optimistic-lock miss (record changed concurrently)`,
			extra: eventLogExtra(event),
		});
		return false;
	}

	recordsDead.add(1, { reason: "max_attempts_exceeded", "event.type": event.eventType });
	logger.warn({
		message: `Failed event ${event.id} reached max attempts, marked as DEAD`,
		extra: { ...eventLogExtra(event), maxAttempts },
	});
	return true;
};

const reinsertAsPending = async (tx: OutboxRepository, event: OutboxRecord): Promise<void> => {
	logger.info({
		message: `Reprocessing failed event ${event.aggregateId} ${event.eventType}`,
		extra: eventLogExtra(event),
	});

	const id = event.id as string;

	await tx.delete(id, "FAILED");

	await tx.create({
		id,
		aggregateId: event.aggregateId,
		aggregateType: event.aggregateType,
		eventType: event.eventType,
		payload: event.payload,
		sequenceNumber: event.sequenceNumber,
		status: "PENDING",
		attempts: event.attempts,
	});

	logger.info({
		message: "Failed event reprocessed",
		extra: eventLogExtra(event),
	});
};

export const run = async (repository: OutboxRepository, { maxAttempts }: ReprocessFailedEventsOptions) => {
	logger.info({
		message: "Starting reprocessing failed events",
		extra: { maxAttempts },
	});

	let batch = 0;
	let totalReprocessed = 0;
	let totalDead = 0;
	// Each record is handled at most once per run. Records that stay FAILED (e.g. a DEAD
	// optimistic-lock miss) or fail again while the run is in progress would otherwise be
	// returned by every subsequent findFailedEvents call and the loop would never end.
	const seen = new Set<string>();

	while (true) {
		const failedEvents = (await repository.findFailedEvents(BATCH_SIZE)).filter(
			(event) => !seen.has(event.id as string),
		);

		if (!failedEvents.length) {
			break;
		}

		for (const event of failedEvents) seen.add(event.id as string);

		batch++;
		logger.info({
			message: `Processing batch ${batch} with ${failedEvents.length} failed events`,
		});

		const exhausted = failedEvents.filter((event) => event.attempts >= maxAttempts);
		const retryable = failedEvents.filter((event) => event.attempts < maxAttempts);
		let batchDead = 0;

		await repository.onTransaction(async (tx) => {
			const deadResults = await Promise.all(exhausted.map((event) => markAsDead(tx, event, maxAttempts)));
			batchDead = deadResults.filter(Boolean).length;
			await Promise.all(retryable.map((event) => reinsertAsPending(tx, event)));
		});

		totalDead += batchDead;
		totalReprocessed += retryable.length;
	}

	if (totalReprocessed === 0 && totalDead === 0) {
		logger.info({
			message: "No failed events to reprocess",
		});
		return;
	}

	logger.info({
		message: "Finished reprocessing failed events",
		extra: { totalReprocessed, totalDead, batches: batch },
	});
};

if (import.meta.main) {
	const { pool } = await import("../db");

	// Importing config.ts is side-effect safe: loadCronConfig does not require
	// replication-only variables (REPLICATION_SLOT_NAME).
	const { columnNaming, tableName, cronRetryConfig } = loadCronConfig();
	const maxAttempts = getIntEnvOrDefault("MAX_OUTBOX_ATTEMPTS", 5, { min: 1 });

	const outboxRepository = new OutboxRepository({
		pool,
		columnNaming,
		tableName,
		retryConfig: cronRetryConfig,
	});

	run(outboxRepository, { maxAttempts }).catch((error) => {
		logger.error({
			message: "Error reprocessing failed events, all operations rolled back",
			error,
		});
	});
}
