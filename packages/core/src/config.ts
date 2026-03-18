import type { RetryConfig } from "./types";

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
	publisherConfigPath: getEnvOrDefault("PUBLISHER_CONFIG_PATH", "./publisher.yaml"),
};

export const dbWriteRetryConfig: RetryConfig = {
	jitter: "full",
	maxDelayInMs: 2000,
	numOfAttempts: 5,
	startingDelayInMs: 200,
};

export const retryQueueConfig: RetryConfig = {
	jitter: "full",
	maxDelayInMs: 10000,
	numOfAttempts: 3,
	startingDelayInMs: 1000,
};

export const maxOutboxAttempts = Number.parseInt(getEnvOrDefault("MAX_OUTBOX_ATTEMPTS", "5"));
