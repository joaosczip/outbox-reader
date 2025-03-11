import "dotenv/config";
import { LogicalReplicationService, Wal2Json, Wal2JsonPlugin } from "pg-logical-replication";

import { OutboxConstructor, OutboxRecord } from "./models/outbox-record";
import { NATSPublisher } from "./nats-publisher";

import { outboxRepositoryFactory } from "./factories";
import { config, natsPublisherRetryConfig } from "./config";
import { Logger } from "./logger";

const outboxRepository = outboxRepositoryFactory();

const logger = new Logger("outbox-reader");
const natsPublisher = new NATSPublisher(logger, natsPublisherRetryConfig);

const filterChanges = (log: Wal2Json.Output) => {
	const onlyInsertsOnOutbox = ({ table, columnnames, kind }: Wal2Json.Change) =>
		table === "outbox" && kind === "insert" && columnnames?.length;

	return log.change.filter(onlyInsertsOnOutbox).map(({ columnnames, columnvalues }) => {
		const columnNamesMapping: Record<string, string> = {
			aggregate_id: "aggregateId",
			aggregate_type: "aggregateType",
			event_type: "eventType",
			created_at: "createdAt",
			processed_at: "processedAt",
		};

		const outboxAttributes = columnnames.reduce((acc: Partial<OutboxConstructor>, dbColumn: string, index) => {
			const outboxColumn = columnNamesMapping[dbColumn as keyof OutboxConstructor] || dbColumn;
			acc[outboxColumn as keyof OutboxConstructor] = columnvalues[index];
			return acc;
		}, {} as Partial<OutboxConstructor>);

		logger.info({
			message: "Received replication data for an outbox record",
			extra: {
				recordId: outboxAttributes.id,
				aggregateId: outboxAttributes.aggregateId,
				aggregateType: outboxAttributes.aggregateType,
				eventType: outboxAttributes.eventType,
			},
		});

		return new OutboxRecord(outboxAttributes as OutboxConstructor);
	});
};

const processOutboxRecord = async (record: OutboxRecord) => {
	try {
		const outbox = await outboxRepository.findUnprocessedById(record.id as string);

		if (!outbox || outbox.status === "PROCESSED") {
			logger.info({ message: `Outbox record ${record.id} already processed`, extra: { recordId: record.id } });
			return;
		}

		if (outbox.attempts >= natsPublisherRetryConfig.numOfAttempts) {
			logger.warn({
				message: `Outbox record ${record.id} reached max attempts`,
				extra: { recordId: record.id, attempts: outbox.attempts },
			});
			return;
		}

		const sequenceNumber = await natsPublisher.publish({
			record: outbox as OutboxRecord,
			retry: (e, attempts) => {
				logger.error({
					message: `Error publishing NATS message`,
					extra: { recordId: record.id, attempts },
					error: e,
				});
				return true;
			},
		});

		await outboxRepository.markAsProcessed({
			id: outbox.id,
			sequenceNumber,
			attempts: outbox.attempts,
			retry: (e, attempts) => {
				logger.error({
					message: `Error marking outbox record ${record.id} as processed`,
					extra: { recordId: record.id, attempts },
					error: e,
				});
				return true;
			},
		});
	} catch (error) {
		logger.error({ message: `Error processing outbox record ${record.id}`, error });

		await outboxRepository.markAsFailed({
			id: record.id as string,
			attempts: record.attempts,
			retry: (e, attempts) => {
				logger.error({
					message: `Error processing outbox record ${record.id}`,
					extra: { recordId: record.id, attempts },
					error: e,
				});
				return true;
			},
		});
	}
};

const startReplication = async () => {
	const { connectionString, slotName } = config;

	const plugin = new Wal2JsonPlugin();

	const replicationService = new LogicalReplicationService({
		connectionString: `${connectionString}?replication=database`,
	});

	replicationService.on("data", async (_, log: Wal2Json.Output) => {
		const outboxRecords = filterChanges(log);
		await Promise.all(outboxRecords.map(processOutboxRecord));
	});

	await replicationService.subscribe(plugin, slotName);
};

startReplication().catch((error) => logger.error({ message: "Error starting replication", error }));
