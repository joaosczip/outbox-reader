import { Logger } from "../logger";
import { OutboxRepository } from "../outbox-repository";

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
						message: `Reprocessing failed event ${event.aggregate_id} ${event.event_type}`,
						extra: {
							id: event.id,
							aggregateId: event.aggregate_id,
							eventType: event.event_type,
							attempts: event.attempts,
						},
					});

					await tx.delete(event.id, "FAILED");

					await tx.create({
						id: event.id,
						aggregateId: event.aggregate_id,
						aggregateType: event.aggregate_type,
						eventType: event.event_type,
						payload: event.payload,
						sequenceNumber: event.sequence_number,
						status: "PENDING",
						attempts: event.attempts,
					});

					logger.info({
						message: "Failed event reprocessed",
						extra: {
							id: event.id,
							aggregateId: event.aggregate_id,
							eventType: event.event_type,
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

	const outboxRepository = new OutboxRepository({
		pool,
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
