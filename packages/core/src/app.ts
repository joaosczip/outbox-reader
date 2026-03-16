import "dotenv/config";
import { Pool } from "pg";
import type { Wal2Json } from "pg-logical-replication";

import { config, dbWriteRetryConfig, natsConnectionConfig, natsPublisherRetryConfig } from "./config";
import { startHealthServer } from "./health";
import { Logger } from "./logger";
import { NATSPublisher } from "./nats-publisher";
import { OutboxProcessor } from "./outbox-processor";
import { OutboxRepository } from "./outbox-repository";
import { startReplication } from "./replication";

const logger = new Logger("outbox-reader");
startHealthServer(); // binds PORT env var (default 4599)

const pool = new Pool({ connectionString: config.connectionString });
const outboxRepository = new OutboxRepository({
	pool,
	retryConfig: dbWriteRetryConfig,
});
const natsPublisher = new NATSPublisher({
	logger,
	retryConfig: natsPublisherRetryConfig,
	connectionConfig: natsConnectionConfig,
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
