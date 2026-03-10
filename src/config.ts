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
};

export const natsConnectionConfig: NATSConnectionConfig = {
	servers: getEnvOrDefault("NATS_SERVERS", "nats://localhost:4222").split(","),
	name: getEnvOrDefault("NATS_CONNECTION_NAME", "outbox-reader"),
	user: process.env.NATS_USER,
	pass: process.env.NATS_PASSWORD,
	token: process.env.NATS_TOKEN,
	maxReconnectAttempts: process.env.NATS_MAX_RECONNECT_ATTEMPTS
		? Number.parseInt(process.env.NATS_MAX_RECONNECT_ATTEMPTS)
		: -1,
	reconnectTimeWait: process.env.NATS_RECONNECT_TIME_WAIT
		? Number.parseInt(process.env.NATS_RECONNECT_TIME_WAIT)
		: 2000,
	timeout: process.env.NATS_TIMEOUT ? Number.parseInt(process.env.NATS_TIMEOUT) : 20000,
	verbose: process.env.NATS_VERBOSE === "true",
	pedantic: process.env.NATS_PEDANTIC === "true",
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
