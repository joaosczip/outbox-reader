// Core library exports for programmatic use
export { PrismaSchemaGenerator } from "./services/prisma-schema-generator";
export { generateOutboxSchema } from "./cli/generate-schema";
export * from "./types/schema-config";

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
export { config, dbWriteRetryConfig, natsPublisherRetryConfig, natsConnectionConfig } from "./config";
