// Core components exports
export { OutboxRepository } from "./outbox-repository";
export { OutboxProcessor } from "./outbox-processor";
export { NATSPublisher } from "./nats-publisher";
export { Logger } from "./logger";
export { startReplication } from "./replication";

// Types exports
export * from "./types";
export * from "./models/outbox-record";

// Configuration exports
export { config, dbWriteRetryConfig } from "./config";

// Publisher config and factory
export { loadPublisherConfig } from "./publisher-config";
export { createPublisher } from "./publisher-factory";
export type {
	PublisherConfig,
	NATSPublisherConfig,
	SQSPublisherConfig,
	KafkaPublisherConfig,
} from "./publisher-config";
