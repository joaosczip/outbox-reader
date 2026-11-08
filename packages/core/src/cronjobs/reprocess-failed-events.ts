import { Logger } from "../logger";
import { OutboxRepository } from "../outbox-repository";
import type { ColumnNaming } from "../utils/column-naming";

const logger = new Logger("outbox-reader:reprocess-failed-events");

export const BATCH_SIZE = 100;

export const run = async (repository: OutboxRepository) => {
	logger.info({
		message: "Starting reprocessing failed events",
	});

	let batch = 0;
	let totalReprocessed = 0;

	while (true) {
		const failedEvents = await repository.findFailedEvents(BATCH_SIZE);

		if (!failedEvents.length) {
			break;
		}

		batch++;
		logger.info({
			message: `Processing batch ${batch} with ${failedEvents.length} failed events`,
		});

		await repository.onTransaction(async (tx) => {
			await Promise.all(
				failedEvents.map(async (event) => {
					logger.info({
						message: `Reprocessing failed event ${event.aggregateId} ${event.eventType}`,
						extra: {
							id: event.id,
							aggregateId: event.aggregateId,
							eventType: event.eventType,
							attempts: event.attempts,
						},
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
						extra: {
							id: event.id,
							aggregateId: event.aggregateId,
							eventType: event.eventType,
							attempts: event.attempts,
						},
					});
				}),
			);
		});

		totalReprocessed += failedEvents.length;
	}

	if (totalReprocessed === 0) {
		logger.info({
			message: "No failed events to reprocess",
		});
		return;
	}

	logger.info({
		message: "Finished reprocessing failed events",
		extra: { totalReprocessed, batches: batch },
	});
};

if (import.meta.main) {
	const { pool } = await import("../db");

	// Read naming settings directly from env (same defaults as src/config.ts);
	// importing config.ts here would require replication-only variables.
	const columnNaming = (process.env.COLUMN_NAMING || "snake_case") as ColumnNaming;
	const tableName = process.env.TABLE_NAME || "outbox";

	const outboxRepository = new OutboxRepository({
		pool,
		columnNaming,
		tableName,
		retryConfig: {
			numOfAttempts: 3,
			startingDelayInMs: 1000,
			maxDelayInMs: 5000,
			jitter: "full",
		},
	});

	run(outboxRepository).catch((error) => {
		logger.error({
			message: "Error reprocessing failed events, all operations rolled back",
			error,
		});
	});
}
