import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import * as configModule from "../src/config";

const MANAGED_KEYS = [
	"DATABASE_URL",
	"REPLICATION_SLOT_NAME",
	"DB_POOL_SIZE",
	"MAX_OUTBOX_ATTEMPTS",
	"COLUMN_NAMING",
	"TABLE_NAME",
	"PUBLISHER_CONFIG_PATH",
	"PENDING_EVENTS_THRESHOLD_MINUTES",
	"PROCESSED_RETENTION_DAYS",
	"DEAD_RETENTION_DAYS",
	"TEST_INT_VAR",
];

describe("config", () => {
	let savedEnv: Record<string, string | undefined>;

	beforeEach(() => {
		savedEnv = {};
		for (const key of MANAGED_KEYS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of MANAGED_KEYS) {
			if (savedEnv[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = savedEnv[key];
			}
		}
	});

	describe("getIntEnvOrDefault", () => {
		it("returns the default when the variable is unset", () => {
			expect(configModule.getIntEnvOrDefault("TEST_INT_VAR", 7, { min: 1 })).toBe(7);
		});

		it("returns the default when the variable is an empty string", () => {
			process.env.TEST_INT_VAR = "";
			expect(configModule.getIntEnvOrDefault("TEST_INT_VAR", 7, { min: 1 })).toBe(7);
		});

		it("parses a valid integer", () => {
			process.env.TEST_INT_VAR = "42";
			expect(configModule.getIntEnvOrDefault("TEST_INT_VAR", 7, { min: 1 })).toBe(42);
		});

		it("accepts a value equal to min", () => {
			process.env.TEST_INT_VAR = "1";
			expect(configModule.getIntEnvOrDefault("TEST_INT_VAR", 7, { min: 1 })).toBe(1);
		});

		it.each(["abc", "12abc", "1.5", "NaN", " "])("throws a clear error for non-integer value %p", (value) => {
			process.env.TEST_INT_VAR = value;
			expect(() => configModule.getIntEnvOrDefault("TEST_INT_VAR", 7, { min: 1 })).toThrow(
				/TEST_INT_VAR must be an integer/,
			);
		});

		it("throws when the value is below min", () => {
			process.env.TEST_INT_VAR = "0";
			expect(() => configModule.getIntEnvOrDefault("TEST_INT_VAR", 7, { min: 1 })).toThrow(
				"Environment variable TEST_INT_VAR must be >= 1 (got 0)",
			);
		});

		it("throws for negative values below min", () => {
			process.env.TEST_INT_VAR = "-3";
			expect(() => configModule.getIntEnvOrDefault("TEST_INT_VAR", 7, { min: 1 })).toThrow(/must be >= 1/);
		});
	});

	describe("loadAppConfig", () => {
		beforeEach(() => {
			process.env.DATABASE_URL = "postgres://u:p@localhost:5432/db";
			process.env.REPLICATION_SLOT_NAME = "slot";
		});

		it("returns defaults for optional variables", () => {
			expect(configModule.loadAppConfig()).toEqual({
				connectionString: "postgres://u:p@localhost:5432/db",
				slotName: "slot",
				dbPoolSize: 10,
				publisherConfigPath: "./publisher.yaml",
				columnNaming: "snake_case",
				tableName: "outbox",
				maxOutboxAttempts: 5,
			});
		});

		it("reads overridden values", () => {
			process.env.DB_POOL_SIZE = "20";
			process.env.MAX_OUTBOX_ATTEMPTS = "8";
			process.env.COLUMN_NAMING = "camelCase";
			process.env.TABLE_NAME = "my_outbox";
			process.env.PUBLISHER_CONFIG_PATH = "/etc/pub.yaml";
			const cfg = configModule.loadAppConfig();
			expect(cfg.dbPoolSize).toBe(20);
			expect(cfg.maxOutboxAttempts).toBe(8);
			expect(cfg.columnNaming).toBe("camelCase");
			expect(cfg.tableName).toBe("my_outbox");
			expect(cfg.publisherConfigPath).toBe("/etc/pub.yaml");
		});

		it("throws when REPLICATION_SLOT_NAME is missing", () => {
			delete process.env.REPLICATION_SLOT_NAME;
			expect(() => configModule.loadAppConfig()).toThrow(
				"Environment variable REPLICATION_SLOT_NAME is required",
			);
		});

		it("throws when DATABASE_URL is missing", () => {
			delete process.env.DATABASE_URL;
			expect(() => configModule.loadAppConfig()).toThrow("Environment variable DATABASE_URL is required");
		});

		it("throws when DB_POOL_SIZE is not an integer (regression: previously NaN)", () => {
			process.env.DB_POOL_SIZE = "ten";
			expect(() => configModule.loadAppConfig()).toThrow(/DB_POOL_SIZE must be an integer/);
		});

		it("throws when DB_POOL_SIZE is below 1", () => {
			process.env.DB_POOL_SIZE = "0";
			expect(() => configModule.loadAppConfig()).toThrow(/DB_POOL_SIZE must be >= 1/);
		});

		it("throws when MAX_OUTBOX_ATTEMPTS is not an integer (regression: previously NaN)", () => {
			process.env.MAX_OUTBOX_ATTEMPTS = "five";
			expect(() => configModule.loadAppConfig()).toThrow(/MAX_OUTBOX_ATTEMPTS must be an integer/);
		});

		it("throws when MAX_OUTBOX_ATTEMPTS is below 1", () => {
			process.env.MAX_OUTBOX_ATTEMPTS = "0";
			expect(() => configModule.loadAppConfig()).toThrow(/MAX_OUTBOX_ATTEMPTS must be >= 1/);
		});

		it.each(["snake_case", "camelCase", "PascalCase"])("accepts COLUMN_NAMING=%s", (naming) => {
			process.env.COLUMN_NAMING = naming;
			expect(configModule.loadAppConfig().columnNaming).toBe(naming as never);
		});

		it("throws on an unknown COLUMN_NAMING value", () => {
			process.env.COLUMN_NAMING = "kebab-case";
			expect(() => configModule.loadAppConfig()).toThrow(
				'Environment variable COLUMN_NAMING must be one of: snake_case, camelCase, PascalCase (got "kebab-case")',
			);
		});
	});

	describe("config (lazy app config used by app.ts)", () => {
		it("does not require REPLICATION_SLOT_NAME to read connectionString", () => {
			process.env.DATABASE_URL = "postgres://u:p@localhost:5432/db";
			expect(configModule.config.connectionString).toBe("postgres://u:p@localhost:5432/db");
		});

		it("throws on access to slotName when REPLICATION_SLOT_NAME is missing", () => {
			expect(() => configModule.config.slotName).toThrow(
				"Environment variable REPLICATION_SLOT_NAME is required",
			);
		});

		it("validates dbPoolSize on access", () => {
			process.env.DB_POOL_SIZE = "abc";
			expect(() => configModule.config.dbPoolSize).toThrow(/DB_POOL_SIZE must be an integer/);
			process.env.DB_POOL_SIZE = "4";
			expect(configModule.config.dbPoolSize).toBe(4);
		});

		it("validates columnNaming on access", () => {
			process.env.COLUMN_NAMING = "SCREAMING";
			expect(() => configModule.config.columnNaming).toThrow(/COLUMN_NAMING must be one of/);
		});
	});

	describe("loadCronConfig", () => {
		beforeEach(() => {
			process.env.DATABASE_URL = "postgres://u:p@localhost:5432/db";
		});

		it("does not require REPLICATION_SLOT_NAME and returns defaults", () => {
			expect(process.env.REPLICATION_SLOT_NAME).toBeUndefined();
			expect(configModule.loadCronConfig()).toEqual({
				connectionString: "postgres://u:p@localhost:5432/db",
				columnNaming: "snake_case",
				tableName: "outbox",
				publisherConfigPath: "./publisher.yaml",
				pendingThresholdMinutes: 10,
				processedRetentionDays: 7,
				deadRetentionDays: undefined,
				cronRetryConfig: {
					numOfAttempts: 3,
					startingDelayInMs: 1000,
					maxDelayInMs: 5000,
					jitter: "full",
				},
			});
		});

		it("reads PENDING_EVENTS_THRESHOLD_MINUTES", () => {
			process.env.PENDING_EVENTS_THRESHOLD_MINUTES = "30";
			expect(configModule.loadCronConfig().pendingThresholdMinutes).toBe(30);
		});

		it("throws when PENDING_EVENTS_THRESHOLD_MINUTES is not an integer", () => {
			process.env.PENDING_EVENTS_THRESHOLD_MINUTES = "soon";
			expect(() => configModule.loadCronConfig()).toThrow(/PENDING_EVENTS_THRESHOLD_MINUTES must be an integer/);
		});

		it("throws when PENDING_EVENTS_THRESHOLD_MINUTES is below 1", () => {
			process.env.PENDING_EVENTS_THRESHOLD_MINUTES = "0";
			expect(() => configModule.loadCronConfig()).toThrow(/PENDING_EVENTS_THRESHOLD_MINUTES must be >= 1/);
		});

		it("reads PROCESSED_RETENTION_DAYS", () => {
			process.env.PROCESSED_RETENTION_DAYS = "30";
			expect(configModule.loadCronConfig().processedRetentionDays).toBe(30);
		});

		it.each([
			["week", /PROCESSED_RETENTION_DAYS must be an integer \(got "week"\)/],
			["1.5", /PROCESSED_RETENTION_DAYS must be an integer/],
			["0", /PROCESSED_RETENTION_DAYS must be >= 1 \(got 0\)/],
			["-3", /PROCESSED_RETENTION_DAYS must be >= 1/],
		])("throws a descriptive error for PROCESSED_RETENTION_DAYS=%s", (raw, message) => {
			process.env.PROCESSED_RETENTION_DAYS = raw;
			expect(() => configModule.loadCronConfig()).toThrow(message);
		});

		it("leaves DEAD purging disabled when DEAD_RETENTION_DAYS is unset or empty", () => {
			expect(configModule.loadCronConfig().deadRetentionDays).toBeUndefined();
			process.env.DEAD_RETENTION_DAYS = "";
			expect(configModule.loadCronConfig().deadRetentionDays).toBeUndefined();
		});

		it("reads DEAD_RETENTION_DAYS when set (opt-in)", () => {
			process.env.DEAD_RETENTION_DAYS = "90";
			expect(configModule.loadCronConfig().deadRetentionDays).toBe(90);
		});

		it.each([
			["never", /DEAD_RETENTION_DAYS must be an integer \(got "never"\)/],
			["0", /DEAD_RETENTION_DAYS must be >= 1 \(got 0\)/],
		])("throws a descriptive error for DEAD_RETENTION_DAYS=%s", (raw, message) => {
			process.env.DEAD_RETENTION_DAYS = raw;
			expect(() => configModule.loadCronConfig()).toThrow(message);
		});

		it("throws when DATABASE_URL is missing", () => {
			delete process.env.DATABASE_URL;
			expect(() => configModule.loadCronConfig()).toThrow("Environment variable DATABASE_URL is required");
		});

		it("validates COLUMN_NAMING", () => {
			process.env.COLUMN_NAMING = "lower";
			expect(() => configModule.loadCronConfig()).toThrow(/COLUMN_NAMING must be one of/);
		});

		it("returns a fresh retry config object on each call", () => {
			const a = configModule.loadCronConfig().cronRetryConfig;
			a.numOfAttempts = 99;
			expect(configModule.loadCronConfig().cronRetryConfig.numOfAttempts).toBe(3);
		});
	});
});
