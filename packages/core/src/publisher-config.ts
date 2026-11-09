import { readFile } from "node:fs/promises";
import type { RetryConfig } from "./types";

export type NATSPublisherConfig = {
	provider: "nats";
	retryConfig: RetryConfig;
	// Reuses NATSConnectionConfig shape — passed directly to NATSPublisher constructor
	options: {
		servers: string | string[];
		subjectPrefix: string;
		name?: string;
		user?: string;
		pass?: string;
		token?: string;
		maxReconnectAttempts?: number;
		reconnectTimeWait?: number;
		timeout?: number;
		verbose?: boolean;
		pedantic?: boolean;
	};
};

export type SQSPublisherConfig = {
	provider: "sqs";
	retryConfig: RetryConfig;
	options: { region: string; queueUrl: string };
};

export type KafkaPublisherConfig = {
	provider: "kafka";
	retryConfig: RetryConfig;
	options: { brokers: string[]; clientId?: string };
};

export type PublisherConfig = NATSPublisherConfig | SQSPublisherConfig | KafkaPublisherConfig;

const KNOWN_PROVIDERS = ["nats", "sqs", "kafka"] as const;

/** Error message for providers that are typed/planned but have no publisher implementation. */
export const notImplementedMessage = (provider: string): string =>
	`Publisher provider "${provider}" is not implemented yet; only "nats" is supported`;
const JITTER_VALUES = ["full", "none"] as const;

type Obj = Record<string, unknown>;

const showValue = (value: unknown): string => (value === undefined ? "undefined" : JSON.stringify(value));

const isObject = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);

const requireObject = (value: unknown, path: string): Obj => {
	if (!isObject(value)) {
		throw new Error(`"${path}" must be an object (got ${showValue(value)})`);
	}
	return value;
};

const requireNonEmptyString = (value: unknown, path: string): void => {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`"${path}" must be a non-empty string (got ${showValue(value)})`);
	}
};

const requireNonEmptyStringArray = (value: unknown, path: string): void => {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`"${path}" must be a non-empty array of strings (got ${showValue(value)})`);
	}
	value.forEach((item, i) => requireNonEmptyString(item, `${path}[${i}]`));
};

const TYPE_CHECKS = {
	string: (value: unknown) => typeof value === "string",
	number: (value: unknown) => typeof value === "number" && Number.isFinite(value),
	boolean: (value: unknown) => typeof value === "boolean",
} as const;

const optionalOfType = (obj: Obj, key: string, type: keyof typeof TYPE_CHECKS, path: string): void => {
	if (!(key in obj)) return;
	const value = obj[key];
	if (!TYPE_CHECKS[type](value)) {
		throw new Error(`"${path}.${key}" must be a ${type} when set (got ${showValue(value)})`);
	}
};

const validateRetryConfig = (value: unknown): void => {
	const retry = requireObject(value, "retryConfig");
	const { numOfAttempts, startingDelayInMs, maxDelayInMs, jitter } = retry;
	if (typeof numOfAttempts !== "number" || !Number.isInteger(numOfAttempts) || numOfAttempts < 1) {
		throw new Error(`"retryConfig.numOfAttempts" must be an integer >= 1 (got ${showValue(numOfAttempts)})`);
	}
	if (
		"startingDelayInMs" in retry &&
		(typeof startingDelayInMs !== "number" || !Number.isFinite(startingDelayInMs) || startingDelayInMs < 0)
	) {
		throw new Error(`"retryConfig.startingDelayInMs" must be a number >= 0 (got ${showValue(startingDelayInMs)})`);
	}
	if (typeof maxDelayInMs !== "number" || !Number.isFinite(maxDelayInMs) || maxDelayInMs < 0) {
		throw new Error(`"retryConfig.maxDelayInMs" must be a number >= 0 (got ${showValue(maxDelayInMs)})`);
	}
	if (!JITTER_VALUES.includes(jitter as (typeof JITTER_VALUES)[number])) {
		throw new Error(`"retryConfig.jitter" must be one of: ${JITTER_VALUES.join(", ")} (got ${showValue(jitter)})`);
	}
};

const validateNatsOptions = (options: Obj): void => {
	const { servers } = options;
	if (Array.isArray(servers)) {
		requireNonEmptyStringArray(servers, "options.servers");
	} else if (typeof servers !== "string" || servers.trim() === "") {
		throw new Error(
			`"options.servers" must be a non-empty string or a non-empty array of strings (got ${showValue(servers)})`,
		);
	}
	requireNonEmptyString(options.subjectPrefix, "options.subjectPrefix");
	for (const key of ["name", "user", "pass", "token"]) optionalOfType(options, key, "string", "options");
	for (const key of ["maxReconnectAttempts", "reconnectTimeWait", "timeout"])
		optionalOfType(options, key, "number", "options");
	for (const key of ["verbose", "pedantic"]) optionalOfType(options, key, "boolean", "options");
};

type Env = Record<string, string | undefined>;

/** Returns the env value, or undefined when it is unset or blank. */
const envValue = (env: Env, key: string): string | undefined => {
	const value = env[key];
	return value === undefined || value.trim() === "" ? undefined : value;
};

/** NATS_SERVERS (or its deprecated alias TARGET_NATS_URL) as a comma-separated list. */
const envServers = (env: Env): string | string[] | undefined => {
	const key = envValue(env, "NATS_SERVERS") !== undefined ? "NATS_SERVERS" : "TARGET_NATS_URL";
	const raw = envValue(env, key);
	if (raw === undefined) return undefined;
	const servers = raw
		.split(",")
		.map((server) => server.trim())
		.filter((server) => server !== "");
	if (servers.length === 0) {
		throw new Error(`${key} must contain at least one server URL (comma-separated)`);
	}
	return servers.length === 1 ? servers[0] : servers;
};

/**
 * NATS options taken from the environment. Each set variable overrides the yaml option:
 * NATS_SERVERS (deprecated alias: TARGET_NATS_URL) → servers, NATS_SUBJECT_PREFIX → subjectPrefix,
 * NATS_USER → user, NATS_PASSWORD → pass, NATS_TOKEN → token, NATS_CONNECTION_NAME → name.
 */
const natsEnvOptions = (env: Env): Obj => {
	const overrides: Obj = {};
	const servers = envServers(env);
	if (servers !== undefined) overrides.servers = servers;
	const subjectPrefix = envValue(env, "NATS_SUBJECT_PREFIX");
	if (subjectPrefix !== undefined) overrides.subjectPrefix = subjectPrefix.trim();
	const mapping: [string, string][] = [
		["NATS_USER", "user"],
		["NATS_PASSWORD", "pass"],
		["NATS_TOKEN", "token"],
		["NATS_CONNECTION_NAME", "name"],
	];
	for (const [key, option] of mapping) {
		const value = envValue(env, key);
		if (value !== undefined) overrides[option] = value;
	}
	return overrides;
};

const defaultNatsConfigFromEnv = (filePath: string, env: Env): Obj => {
	const overrides = natsEnvOptions(env);
	if (overrides.servers === undefined || overrides.subjectPrefix === undefined) {
		throw new Error(
			`Publisher config file "${filePath}" not found. Either create it (see publisher.example.yaml) and point PUBLISHER_CONFIG_PATH to it, or set NATS_SERVERS and NATS_SUBJECT_PREFIX to configure NATS from the environment.`,
		);
	}
	return {
		provider: "nats",
		retryConfig: { numOfAttempts: 5, startingDelayInMs: 500, maxDelayInMs: 5000, jitter: "full" },
		options: {
			name: "outbox-reader",
			maxReconnectAttempts: -1,
			reconnectTimeWait: 2000,
			timeout: 20000,
			...overrides,
		},
	};
};

const readYamlConfig = async (filePath: string, env: Env): Promise<{ cfg: Obj; source: string }> => {
	let raw: string;
	try {
		raw = await readFile(filePath, "utf-8");
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
			return {
				cfg: defaultNatsConfigFromEnv(filePath, env),
				source: `environment (file "${filePath}" not found)`,
			};
		}
		throw new Error(`Failed to read publisher config at "${filePath}": ${(cause as Error).message}`);
	}

	let parsed: unknown;
	try {
		parsed = Bun.YAML.parse(raw);
	} catch (cause) {
		throw new Error(`Failed to parse publisher config YAML at "${filePath}": ${(cause as Error).message}`);
	}

	return { cfg: (isObject(parsed) ? parsed : {}) as Obj, source: `"${filePath}"` };
};

/**
 * Loads the publisher config from `filePath` (YAML). For provider `nats`, NATS_* environment variables
 * override the yaml options; when the file does not exist, a default NATS config is built from the
 * environment (requires NATS_SERVERS/TARGET_NATS_URL and NATS_SUBJECT_PREFIX). Validation runs last.
 */
export async function loadPublisherConfig(filePath: string, env: Env = process.env): Promise<PublisherConfig> {
	const { cfg, source } = await readYamlConfig(filePath, env);
	const provider = cfg.provider;

	if (!KNOWN_PROVIDERS.includes(provider as (typeof KNOWN_PROVIDERS)[number])) {
		throw new Error(`Unknown publisher provider "${provider}". Must be one of: ${KNOWN_PROVIDERS.join(", ")}`);
	}
	if (provider !== "nats") {
		throw new Error(notImplementedMessage(provider as string));
	}

	try {
		if (isObject(cfg.options)) cfg.options = { ...cfg.options, ...natsEnvOptions(env) };
		validateRetryConfig(cfg.retryConfig);
		validateNatsOptions(requireObject(cfg.options, "options"));
	} catch (cause) {
		throw new Error(`Invalid publisher config at ${source} (provider "${provider}"): ${(cause as Error).message}`);
	}

	return cfg as PublisherConfig;
}
