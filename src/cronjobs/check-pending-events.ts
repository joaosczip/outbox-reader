import "dotenv/config";
import { connect, NatsError } from "nats";
import { outboxRepositoryFactory } from "../factories";
import { Logger } from "shared/logger";
import { OutboxRecord } from "../models/outbox-record";

const prismaRepository = outboxRepositoryFactory();
const logger = new Logger("outbox-reader:check-pending-events");

export const run = async () => {
	const minutes = 10;
	const pendingEvens = await prismaRepository.findRecentPendingEvents(minutes);

	if (!pendingEvens.length) {
		logger.info({
			message: "No pending events found",
		});
		return;
	}

	logger.info({
		message: "Found pending events",
		extra: {
			count: pendingEvens.length,
		},
	});

	const nc = await connect({
		servers: ["nats://127.0.0.1:4222"],
	});

	const jsm = await nc.jetstreamManager();

	const lastProcessedEvent = await prismaRepository.findLastProcessedEvent();
	let lastSequenceNumber = 0;

	let eventsToBeMarkedAsFailed: OutboxRecord[] = [];

	if (!lastProcessedEvent) {
		logger.info({
			message: "No last processed event found. Sequence number will start on 0",
		});
	} else {
		logger.info({
			message: "Found last processed event",
			extra: {
				id: lastProcessedEvent.id,
				sequenceNumber: lastProcessedEvent.sequenceNumber,
			},
		});
		lastSequenceNumber = lastProcessedEvent.sequenceNumber;
	}

	while (pendingEvens.length) {
		const event = pendingEvens.shift() as OutboxRecord;

		const lookupSequenceNumber = lastSequenceNumber + 1;

		logger.info({
			message: "Searching for message with sequence number",
			extra: {
				sequenceNumber: lookupSequenceNumber,
			},
		});

		try {
			const publishedMessage = await jsm.streams.getMessage("orders", {
				seq: lastSequenceNumber + 1,
			});
			logger.info({
				message: "Message found, event will me mark as processed",
				extra: {
					eventId: event.id,
					sequenceNumber: lookupSequenceNumber,
				},
			});

			await prismaRepository.markAsProcessed({
				id: event.id as string,
				sequenceNumber: publishedMessage.seq,
				attempts: event.attempts,
				retry: (e, attempts) => {
					logger.error({
						message: "Filed to to mark event as processed",
						error: e,
						extra: {
							eventId: event.id,
							attempts,
						},
					});
					return true;
				},
			});

			lastSequenceNumber = lookupSequenceNumber;
		} catch (error) {
			const natsErr = error as NatsError;
			if (natsErr.code === "404") {
				logger.info({
					message: `Message with sequence ${lookupSequenceNumber} not found. No need to continue the current check, all next events will be skipped`,
					extra: {
						eventId: event.id,
						sequenceNumber: lookupSequenceNumber,
					},
				});

				eventsToBeMarkedAsFailed = [event, ...pendingEvens.splice(0)] as OutboxRecord[];
			} else {
				logger.error({
					message: "Failed to get message",
					error,
					extra: {
						eventId: event.id,
						sequenceNumber: lookupSequenceNumber,
					},
				});
			}
		}
	}

	if (eventsToBeMarkedAsFailed.length) {
		logger.info({
			message: "Marking events as failed",
			extra: {
				count: eventsToBeMarkedAsFailed.length,
			},
		});

		await prismaRepository.outbox.updateMany({
			where: {
				id: {
					in: eventsToBeMarkedAsFailed.map((e) => e.id) as string[],
				},
			},
			data: {
				status: "FAILED",
			},
		});

		logger.info({
			message: "All events marked as failed",
			extra: {
				count: eventsToBeMarkedAsFailed.length,
			},
		});
	}

	logger.info({
		message: "All pending events processed",
	});

	process.exit(0);
};

run().catch(console.error);
