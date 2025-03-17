import "dotenv/config";
import { Pool } from "pg";
import { Wal2Json } from "pg-logical-replication";

import { NATSPublisher } from "./nats-publisher";
import { Logger } from "./logger";
import { config, dbWriteRetryConfig, natsPublisherRetryConfig } from "./config";
import { OutboxRepository } from "./outbox-repository";
import { startReplication } from "./replication";
import { OutboxProcessor } from "./outbox-processor";

const logger = new Logger("outbox-reader");
const pool = new Pool({ connectionString: config.connectionString });
const outboxRepository = new OutboxRepository({
	pool,
	retryConfig: dbWriteRetryConfig,
});
const natsPublisher = new NATSPublisher({
	logger,
	retryConfig: natsPublisherRetryConfig,
});

const outboxProcessor = new OutboxProcessor({ outboxRepository, logger });

const { connectionString, slotName } = config;

const outboxReplication = startReplication({
	connectionString,
	slotName,
	onChange: async (log: Wal2Json.Output) => {
		const outboxRecords = outboxProcessor.filterChanges(log);
		await Promise.all(
			outboxRecords.map(async (record) =>
				outboxProcessor.processInserts({ insertedRecord: record, publisher: natsPublisher }),
			),
		);
	},
});

outboxReplication.catch((error) => logger.error({ message: "Error starting replication", error }));
