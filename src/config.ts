import { RetryConfig } from "./types";

export const getEnvOrThrow = (key: string): string => {
	const value = process.env[key];
	if (!value) {
		throw new Error(`Environment variable ${key} is required`);
	}
	return value;
};

export const config = {
	connectionString: getEnvOrThrow("DATABASE_URL"),
	slotName: getEnvOrThrow("REPLICATION_SLOT_NAME"),
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
