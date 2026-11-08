import type { RetryConfig } from "./types";
import type { ColumnNaming } from "./utils/column-naming";

// This module must stay side-effect free apart from validating optional values with
// defaults: cronjobs import it (directly or via db/pool.ts) and must not require
// app-only variables such as REPLICATION_SLOT_NAME.

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

export type IntEnvOptions = { min?: number };

export const getIntEnvOrDefault = (key: string, defaultValue: number, { min }: IntEnvOptions = {}): number => {
	const raw = process.env[key];
	if (raw === undefined || raw === "") {
		return defaultValue;
	}
	if (!/^-?\d+$/.test(raw.trim())) {
		throw new Error(`Environment variable ${key} must be an integer (got "${raw}")`);
	}
	const value = Number(raw.trim());
	if (min !== undefined && value < min) {
		throw new Error(`Environment variable ${key} must be >= ${min} (got ${value})`);
	}
	return value;
};

/**
 * Like getIntEnvOrDefault, but an unset/empty variable yields `undefined` (feature disabled)
 * instead of a default. A set value is validated the same way.
 */
export const getOptionalIntEnv = (key: string, options: IntEnvOptions = {}): number | undefined => {
	const raw = process.env[key];
	if (raw === undefined || raw === "") {
		return undefined;
	}
	return getIntEnvOrDefault(key, 0, options);
};

const COLUMN_NAMINGS: readonly ColumnNaming[] = ["snake_case", "camelCase", "PascalCase"];

const getColumnNaming = (): ColumnNaming => {
	const value = getEnvOrDefault("COLUMN_NAMING", "snake_case");
	if (!COLUMN_NAMINGS.includes(value as ColumnNaming)) {
		throw new Error(
			`Environment variable COLUMN_NAMING must be one of: ${COLUMN_NAMINGS.join(", ")} (got "${value}")`,
		);
	}
	return value as ColumnNaming;
};

const getConnectionString = () => getEnvOrThrow("DATABASE_URL");
const getPublisherConfigPath = () => getEnvOrDefault("PUBLISHER_CONFIG_PATH", "./publisher.yaml");
const getTableName = () => getEnvOrDefault("TABLE_NAME", "outbox");
const getMaxOutboxAttempts = () => getIntEnvOrDefault("MAX_OUTBOX_ATTEMPTS", 5, { min: 1 });

export type AppConfig = {
	readonly connectionString: string;
	readonly slotName: string;
	readonly dbPoolSize: number;
	readonly publisherConfigPath: string;
	readonly columnNaming: ColumnNaming;
	readonly tableName: string;
};

/**
 * Lazily-evaluated app config: each property reads and validates its env var on access,
 * so importing this module never throws for a missing REPLICATION_SLOT_NAME. Accessing a
 * required property whose variable is missing/invalid throws at that point.
 */
export const config: AppConfig = {
	get connectionString() {
		return getConnectionString();
	},
	get slotName() {
		return getEnvOrThrow("REPLICATION_SLOT_NAME");
	},
	get dbPoolSize() {
		return getIntEnvOrDefault("DB_POOL_SIZE", 10, { min: 1 });
	},
	get publisherConfigPath() {
		return getPublisherConfigPath();
	},
	get columnNaming() {
		return getColumnNaming();
	},
	get tableName() {
		return getTableName();
	},
};

/** Eagerly reads and validates every app variable at once (fail-fast snapshot). */
export const loadAppConfig = (): AppConfig & { readonly maxOutboxAttempts: number } => ({
	connectionString: config.connectionString,
	slotName: config.slotName,
	dbPoolSize: config.dbPoolSize,
	publisherConfigPath: config.publisherConfigPath,
	columnNaming: config.columnNaming,
	tableName: config.tableName,
	maxOutboxAttempts: getMaxOutboxAttempts(),
});

export type CronConfig = {
	connectionString: string;
	columnNaming: ColumnNaming;
	tableName: string;
	publisherConfigPath: string;
	pendingThresholdMinutes: number;
	/** purge-processed-events: delete PROCESSED records older than this many days. */
	processedRetentionDays: number;
	/** purge-processed-events: delete DEAD records older than this many days; undefined = never. */
	deadRetentionDays: number | undefined;
	cronRetryConfig: RetryConfig;
};

/** Config for cronjobs. Does not require REPLICATION_SLOT_NAME. */
export const loadCronConfig = (): CronConfig => ({
	connectionString: getConnectionString(),
	columnNaming: getColumnNaming(),
	tableName: getTableName(),
	publisherConfigPath: getPublisherConfigPath(),
	pendingThresholdMinutes: getIntEnvOrDefault("PENDING_EVENTS_THRESHOLD_MINUTES", 10, { min: 1 }),
	processedRetentionDays: getIntEnvOrDefault("PROCESSED_RETENTION_DAYS", 7, { min: 1 }),
	deadRetentionDays: getOptionalIntEnv("DEAD_RETENTION_DAYS", { min: 1 }),
	cronRetryConfig: {
		numOfAttempts: 3,
		startingDelayInMs: 1000,
		maxDelayInMs: 5000,
		jitter: "full",
	},
});

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

// Kept as an eager number export for app.ts. It has a default, so it only throws on
// import when MAX_OUTBOX_ATTEMPTS is set to an invalid value (fail-fast on misconfig).
export const maxOutboxAttempts: number = getMaxOutboxAttempts();
