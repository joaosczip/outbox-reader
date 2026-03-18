import "dotenv/config";
import pAll from "p-all";
import { Pool } from "pg";
import type { LogicalReplicationService, Wal2Json } from "pg-logical-replication";

import { config, dbWriteRetryConfig } from "./config";
import { startHealthServer } from "./health";
import { Logger } from "./logger";
import { OutboxProcessor } from "./outbox-processor";
import { OutboxRepository } from "./outbox-repository";
import { loadPublisherConfig } from "./publisher-config";
import { createPublisher } from "./publisher-factory";
import { startReplication } from "./replication";
import type { Publisher } from "./types";

const logger = new Logger("outbox-reader");
const healthServer = startHealthServer(); // binds PORT env var (default 4599)

const pool = new Pool({ connectionString: config.connectionString, max: config.dbPoolSize });
const outboxRepository = new OutboxRepository({
	pool,
	retryConfig: dbWriteRetryConfig,
});

const outboxProcessor = new OutboxProcessor({ outboxRepository, logger, maxAttempts: config.maxAttempts });

let publisher: Publisher | null = null;

const { connectionString, slotName } = config;

let replicationService: LogicalReplicationService | null = null;
let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
	if (isShuttingDown) return;
	isShuttingDown = true;

	logger.info({ message: `Received ${signal}, starting graceful shutdown` });
	const errors: unknown[] = [];

	// 1. Stop health server immediately (drop readiness; important for k8s)
	try {
		healthServer.stop(true);
	} catch (err) {
		logger.error({ message: "Error stopping health server", error: err });
		errors.push(err);
	}

	// 2. Stop WAL replication (waits for the in-flight onChange to complete)
	if (replicationService) {
		try {
			logger.info({ message: "Stopping replication service" });
			await replicationService.stop();
			logger.info({ message: "Replication service stopped" });
		} catch (err) {
			logger.error({ message: "Error stopping replication service", error: err });
			errors.push(err);
		}
	}

	// 3. Close publisher
	if (publisher) {
		try {
			await publisher.close();
		} catch (err) {
			logger.error({ message: "Error closing publisher connection", error: err });
			errors.push(err);
		}
	}

	// 4. End pg pool
	try {
		logger.info({ message: "Ending database pool" });
		await pool.end();
		logger.info({ message: "Database pool ended" });
	} catch (err) {
		logger.error({ message: "Error ending database pool", error: err });
		errors.push(err);
	}

	logger.info({ message: "Graceful shutdown complete" });
	process.exit(errors.length > 0 ? 1 : 0);
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

(async () => {
	const publisherConfig = await loadPublisherConfig(config.publisherConfigPath);
	publisher = createPublisher(publisherConfig, logger);

	await publisher.connect();

	replicationService = await startReplication({
		connectionString,
		slotName,
		onChange: async (log: Wal2Json.Output) => {
			const outboxRecords = outboxProcessor.filterChanges(log);

			const ids = outboxRecords.map((r) => r.id as string);
			const fetchedRecords = await outboxRepository.findUnprocessedByIds(ids);
			const fetchedMap = new Map(fetchedRecords.map((r) => [r.id, r]));

			const activePublisher = publisher as Publisher;
			await pAll(
				outboxRecords.map(
					(record) => () =>
						outboxProcessor.processInserts({
							insertedRecord: record,
							prefetchedOutbox: fetchedMap.get(record.id as string) ?? null,
							publisher: activePublisher,
						}),
				),
				{ concurrency: config.dbPoolSize },
			);
		},
	});
})().catch((error) => logger.error({ message: "Error starting replication", error }));
