// Public API for programmatic use.
//
// Importing this module must stay side-effect free: it must not start telemetry
// (./telemetry is only imported by app.ts), start the health server or read required
// env vars such as DATABASE_URL / REPLICATION_SLOT_NAME (config getters are lazy).

// Core components
export { OutboxRepository } from "./outbox-repository";
export { OutboxProcessor } from "./outbox-processor";
export { NATSPublisher } from "./nats-publisher";
export { RetryQueue } from "./retry-queue";
export { Logger } from "./logger";
export { startReplication, buildReplicationConnectionString } from "./replication";
export { createWalChangeHandler } from "./wal-change-handler";
export type { WalChangeHandlerDeps, WalChangeHandlerMetrics } from "./wal-change-handler";

// Health server
export { startHealthServer, DEFAULT_CHECK_TIMEOUT_MS } from "./health";
export type { HealthServer, HealthServerOptions, ReadinessCheck, CheckResult } from "./health";

// Utilities
export { runOrderedByKey } from "./utils/run-ordered-by-key";
export type { RunOrderedByKeyOptions } from "./utils/run-ordered-by-key";
export { getColumnNames, applyNamingToTableName } from "./utils/column-naming";
export type { ColumnNaming, OutboxColumnNames } from "./utils/column-naming";

// Types
export * from "./types";
export * from "./models/outbox-record";

// Configuration
export {
	config,
	loadAppConfig,
	loadCronConfig,
	dbWriteRetryConfig,
	retryQueueConfig,
	maxOutboxAttempts,
} from "./config";
export type { AppConfig, CronConfig } from "./config";

// Publisher config and factory
export { loadPublisherConfig } from "./publisher-config";
export { createPublisher } from "./publisher-factory";
export type {
	PublisherConfig,
	NATSPublisherConfig,
	SQSPublisherConfig,
	KafkaPublisherConfig,
} from "./publisher-config";
