import "dotenv/config";

import { Logger } from "../logger";
import { OutboxRepository } from "../outbox-repository";
import { pool } from "../db";

const outboxRepository = new OutboxRepository({
	pool,
	retryConfig: {
		numOfAttempts: 3,
		startingDelayInMs: 1000,
		maxDelayInMs: 5000,
		jitter: "full",
	},
});
const logger = new Logger("outbox-reader:reprocess-failed-events");

const run = async () => {
	logger.info({
		message: "Starting reprocessing failed events",
	});
	const failedEvents = await outboxRepository.findFailedEvents();

	if (!failedEvents.length) {
		logger.info({
			message: "No failed events to reprocess",
		});
		return;
	}

	logger.info({
		message: `Found ${failedEvents.length} failed events`,
	});

	await outboxRepository.onTransaction(async (tx) => {
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

				await tx.delete(event.id, "FAILED");

				await tx.create({
					...event,
					payload: event.payload as any,
					status: "PENDING",
					attempts: event.attempts,
				});

				logger.info({
					message: `Failed event reprocessed`,
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

	logger.info({
		message: "Finished reprocessing failed events",
	});
};

run().catch((error) => {
	logger.error({
		message: "Error reprocessing failed events, all operations rolled back",
		error,
	});
});
