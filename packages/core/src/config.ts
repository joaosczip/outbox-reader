import type { NATSConnectionConfig, RetryConfig } from "./types";

export const getEnvOrThrow = (key: string): string => {
	const value = process.env[key];
	if (!value) {
		throw new Error(`Environment variable ${key} is required`);
	}
	return value;
};

export const getEnvOrDefault = (key: string, defaultValue: string): string => {
	return process.env[key] || defaultValue;
};

export const config = {
	connectionString: getEnvOrThrow("DATABASE_URL"),
	slotName: getEnvOrThrow("REPLICATION_SLOT_NAME"),
	dbPoolSize: Number.parseInt(getEnvOrDefault("DB_POOL_SIZE", "10")),
	processingFailureMode: getEnvOrDefault("PROCESSING_FAILURE_MODE", "abort") as "abort" | "reprocess-after-delay",
	failedEventsRetryDelayMs: Number.parseInt(getEnvOrDefault("FAILED_EVENTS_RETRY_DELAY_MS", "5000")),
};

export const natsConnectionConfig: NATSConnectionConfig = {
	servers: getEnvOrDefault("TARGET_NATS_URL", "nats://localhost:4222"),
	name: "outbox-reader",
	maxReconnectAttempts: -1,
	reconnectTimeWait: 2000,
	timeout: 20000,
};

export const dbWriteRetryConfig: RetryConfig = {
	jitter: "full",
	maxDelayInMs: 5000,
	numOfAttempts: 10,
	startingDelayInMs: 300,
};

export const natsPublisherRetryConfig: RetryConfig = {
	jitter: "full",
	maxDelayInMs: 10000,
	numOfAttempts: 10,
	startingDelayInMs: 1000,
};
