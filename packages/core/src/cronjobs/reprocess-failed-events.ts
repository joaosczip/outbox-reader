import { getIntEnvOrDefault, loadCronConfig } from "../config";
import { Logger } from "../logger";
import { optimisticLockMisses, recordsDead } from "../metrics";
import type { OutboxRecord } from "../models/outbox-record";
import { OutboxRepository } from "../outbox-repository";

const defaultLogger = new Logger("outbox-reader:reprocess-failed-events");

export const BATCH_SIZE = 100;

export type ReprocessFailedEventsOptions = {
	/** FAILED records with `attempts >= maxAttempts` are marked DEAD instead of being re-inserted. */
	maxAttempts: number;
	logger?: Pick<Logger, "info" | "warn" | "error">;
};

export type ReprocessSummary = {
	totalReprocessed: number;
	totalDead: number;
	/** Exhausted records not marked DEAD because they changed concurrently (optimistic-lock miss). */
	lockMisses: number;
	batches: number;
};

type ReprocessRepository = Pick<
	OutboxRepository,
	"findFailedEvents" | "onTransaction" | "requeueFailed" | "markManyAsDead"
>;

const eventLogExtra = (event: OutboxRecord) => ({
	id: event.id,
	aggregateId: event.aggregateId,
	eventType: event.eventType,
	attempts: event.attempts,
});

export const run = async (
	repository: ReprocessRepository,
	{ maxAttempts, logger = defaultLogger }: ReprocessFailedEventsOptions,
): Promise<ReprocessSummary> => {
	logger.info({
		message: "Starting reprocessing failed events",
		extra: { maxAttempts },
	});

	const summary: ReprocessSummary = { totalReprocessed: 0, totalDead: 0, lockMisses: 0, batches: 0 };
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

		summary.batches++;
		logger.info({
			message: `Processing batch ${summary.batches} with ${failedEvents.length} failed events`,
		});

		const exhausted = failedEvents.filter((event) => event.attempts >= maxAttempts);
		const retryable = failedEvents.filter((event) => event.attempts < maxAttempts);
		let deadIds = new Set<string>();
		let requeuedIds = new Set<string>();

		// Set-based writes: one UPDATE for every exhausted record and one DELETE+INSERT statement for
		// every retryable record, instead of 2N+ round trips serialised on the transaction's client.
		await repository.onTransaction(async (tx) => {
			if (exhausted.length) {
				deadIds = new Set(
					await tx.markManyAsDead(
						exhausted.map((event) => ({ id: event.id as string, attempts: event.attempts })),
					),
				);
			}
			if (retryable.length) {
				requeuedIds = new Set(await tx.requeueFailed(retryable.map((event) => event.id as string)));
			}
		});

		// Logs and metrics are emitted only after COMMIT, so they describe persisted changes.
		for (const event of exhausted) {
			if (deadIds.has(event.id as string)) {
				summary.totalDead++;
				recordsDead.add(1, { reason: "max_attempts_exceeded", "event.type": event.eventType });
				logger.warn({
					message: `Failed event ${event.id} reached max attempts, marked as DEAD`,
					extra: { ...eventLogExtra(event), maxAttempts },
				});
			} else {
				summary.lockMisses++;
				optimisticLockMisses.add(1, { operation: "mark_dead", "event.type": event.eventType });
				logger.warn({
					message: `Failed event ${event.id} was not marked as DEAD: optimistic-lock miss (record changed concurrently)`,
					extra: eventLogExtra(event),
				});
			}
		}

		for (const event of retryable) {
			if (requeuedIds.has(event.id as string)) {
				summary.totalReprocessed++;
				logger.info({
					message: `Failed event ${event.aggregateId} ${event.eventType} reprocessed`,
					extra: eventLogExtra(event),
				});
			} else {
				logger.warn({
					message: `Failed event ${event.id} was not requeued: it is no longer FAILED (record changed concurrently)`,
					extra: eventLogExtra(event),
				});
			}
		}
	}

	if (summary.totalReprocessed === 0 && summary.totalDead === 0 && summary.lockMisses === 0) {
		logger.info({
			message: "No failed events to reprocess",
		});
		return summary;
	}

	logger.info({
		message: "Finished reprocessing failed events",
		extra: summary,
	});
	return summary;
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
		defaultLogger.error({
			message: "Error reprocessing failed events, all operations rolled back",
			error,
		});
	});
}
