import "dotenv/config";
import pSettle from "p-settle";
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

const pool = new Pool({ connectionString: config.connectionString, max: config.dbPoolSize });
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

(async () => {
	await natsPublisher.connect();

	const outboxReplication = startReplication({
		connectionString,
		slotName,
		onChange: async (log: Wal2Json.Output) => {
			const outboxRecords = outboxProcessor.filterChanges(log);

			const results = await pSettle(
				outboxRecords.map(
					(record) => () =>
						outboxProcessor.processInserts({ insertedRecord: record, publisher: natsPublisher }),
				),
				{ concurrency: config.dbPoolSize },
			);

			if (config.processingFailureMode === "reprocess-after-delay") {
				const failedRecords = outboxRecords.filter((_, i) => results[i].isRejected);

				if (failedRecords.length) {
					await new Promise((resolve) => setTimeout(resolve, config.failedEventsRetryDelayMs));
					await pSettle(
						failedRecords.map(
							(record) => () =>
								outboxProcessor.processInserts({ insertedRecord: record, publisher: natsPublisher }),
						),
						{ concurrency: config.dbPoolSize },
					);
				}
			}
		},
	});

	outboxReplication.catch((error) => logger.error({ message: "Error starting replication", error }));
})();
