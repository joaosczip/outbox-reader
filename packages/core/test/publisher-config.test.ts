import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

// mock.module must be declared before the import under test
const mockReadFile = mock(async (_path: string, _enc: string): Promise<string> => "");
mock.module("node:fs/promises", () => ({ readFile: mockReadFile }));

import { loadPublisherConfig } from "../src/publisher-config";

const fsError = (code: string, message: string) =>
	Object.assign(new Error(`${code}: ${message}`), { code }) as NodeJS.ErrnoException;

const validNatsYaml = `
provider: nats
retryConfig:
  numOfAttempts: 5
  startingDelayInMs: 500
  maxDelayInMs: 5000
  jitter: full
options:
  servers: nats://localhost:4222
  name: outbox-reader
  subjectPrefix: events
`;

describe("loadPublisherConfig", () => {
	beforeEach(() => mockReadFile.mockReset());

	it("parses a valid NATS config", async () => {
		mockReadFile.mockResolvedValue(validNatsYaml);
		const cfg = await loadPublisherConfig("./publisher.yaml", {});
		expect(cfg.provider).toBe("nats");
		expect(cfg.retryConfig.numOfAttempts).toBe(5);
		if (cfg.provider === "nats") {
			expect(cfg.options.servers).toBe("nats://localhost:4222");
		}
	});

	it("accepts an array of NATS servers", async () => {
		mockReadFile.mockResolvedValue(
			"provider: nats\nretryConfig: {numOfAttempts: 3, startingDelayInMs: 100, maxDelayInMs: 1000, jitter: full}\noptions:\n  subjectPrefix: events\n  servers:\n    - nats://a:4222\n    - nats://b:4222",
		);
		const cfg = await loadPublisherConfig("./publisher.yaml", {});
		if (cfg.provider === "nats") {
			expect(Array.isArray(cfg.options.servers)).toBe(true);
		}
	});

	it("throws when file cannot be read for a reason other than not existing", async () => {
		mockReadFile.mockRejectedValue(fsError("EACCES", "permission denied"));
		await expect(loadPublisherConfig("./unreadable.yaml", {})).rejects.toThrow("Failed to read");
	});

	it("error message includes the file path", async () => {
		mockReadFile.mockRejectedValue(fsError("EACCES", "permission denied"));
		await expect(loadPublisherConfig("./my-config.yaml", {})).rejects.toThrow("my-config.yaml");
	});

	it("does not fall back to env for read errors other than ENOENT", async () => {
		mockReadFile.mockRejectedValue(fsError("EISDIR", "illegal operation on a directory"));
		await expect(
			loadPublisherConfig("./dir.yaml", { NATS_SERVERS: "nats://a:4222", NATS_SUBJECT_PREFIX: "events" }),
		).rejects.toThrow('Failed to read publisher config at "./dir.yaml"');
	});

	it("throws on unknown provider", async () => {
		mockReadFile.mockResolvedValue("provider: rabbitmq\nretryConfig: {}\noptions: {}");
		await expect(loadPublisherConfig("./publisher.yaml", {})).rejects.toThrow("rabbitmq");
	});

	it("throws on invalid YAML", async () => {
		// Spy on the global so we can simulate a parse error
		const parseSpy = spyOn(Bun.YAML, "parse").mockImplementation(() => {
			throw new SyntaxError("unexpected token");
		});
		mockReadFile.mockResolvedValue("anything");
		await expect(loadPublisherConfig("./publisher.yaml", {})).rejects.toThrow("Failed to parse");
		parseSpy.mockRestore();
	});
	describe("validation", () => {
		type Obj = Record<string, unknown>;
		const retry = (): Obj => ({ numOfAttempts: 3, startingDelayInMs: 100, maxDelayInMs: 1000, jitter: "full" });
		const nats = (): Obj => ({
			provider: "nats",
			retryConfig: retry(),
			options: { servers: "nats://a:4222", subjectPrefix: "events" },
		});

		// JSON is valid YAML, so fixtures can be expressed as plain objects
		const load = (cfg: unknown) => {
			mockReadFile.mockResolvedValue(JSON.stringify(cfg));
			return loadPublisherConfig("./publisher.yaml", {});
		};
		const withRetry = (base: Obj, patch: Obj): Obj => ({
			...base,
			retryConfig: { ...(base.retryConfig as Obj), ...patch },
		});
		const withOptions = (base: Obj, patch: Obj): Obj => ({
			...base,
			options: { ...(base.options as Obj), ...patch },
		});

		it("accepts a valid NATS config and returns it unchanged", async () => {
			const cfg = nats();
			expect(await load(cfg)).toEqual(cfg as never);
		});

		it("accepts jitter 'none' and a config without startingDelayInMs", async () => {
			const cfg = withRetry(nats(), { jitter: "none" });
			Reflect.deleteProperty(cfg.retryConfig as Obj, "startingDelayInMs");
			expect(await load(cfg)).toEqual(cfg as never);
		});

		it("accepts all optional NATS fields when correctly typed", async () => {
			const cfg = withOptions(nats(), {
				name: "outbox-reader",
				user: "u",
				pass: "p",
				token: "t",
				maxReconnectAttempts: -1,
				reconnectTimeWait: 2000,
				timeout: 20000,
				verbose: false,
				pedantic: true,
			});
			expect(await load(cfg)).toEqual(cfg as never);
		});

		it("throws when the document is not a mapping", async () => {
			mockReadFile.mockResolvedValue("- a\n- b");
			await expect(loadPublisherConfig("./publisher.yaml", {})).rejects.toThrow(/Unknown publisher provider/);
		});

		it("throws when retryConfig is missing", async () => {
			const cfg = nats();
			Reflect.deleteProperty(cfg, "retryConfig");
			await expect(load(cfg)).rejects.toThrow('"retryConfig" must be an object');
		});

		it("throws when options is missing", async () => {
			const cfg = nats();
			Reflect.deleteProperty(cfg, "options");
			await expect(load(cfg)).rejects.toThrow('"options" must be an object');
		});

		it.each([
			["numOfAttempts", 0, "retryConfig.numOfAttempts"],
			["numOfAttempts", 1.5, "retryConfig.numOfAttempts"],
			["numOfAttempts", "3", "retryConfig.numOfAttempts"],
			["numOfAttempts", undefined, "retryConfig.numOfAttempts"],
			["startingDelayInMs", -1, "retryConfig.startingDelayInMs"],
			["startingDelayInMs", "100", "retryConfig.startingDelayInMs"],
			["maxDelayInMs", -5, "retryConfig.maxDelayInMs"],
			["maxDelayInMs", undefined, "retryConfig.maxDelayInMs"],
			["jitter", "fixed", "retryConfig.jitter"],
			["jitter", undefined, "retryConfig.jitter"],
		])("rejects retryConfig.%s = %p naming the field", async (field, value, path) => {
			const cfg = withRetry(nats(), { [field]: value });
			if (value === undefined) delete (cfg.retryConfig as Obj)[field];
			await expect(load(cfg)).rejects.toThrow(path);
		});

		it.each([
			["servers", undefined, "options.servers"],
			["servers", "", "options.servers"],
			["servers", [], "options.servers"],
			["servers", ["nats://a:4222", ""], "options.servers[1]"],
			["servers", ["nats://a:4222", 42], "options.servers[1]"],
			["servers", 4222, "options.servers"],
			["subjectPrefix", undefined, "options.subjectPrefix"],
			["subjectPrefix", "", "options.subjectPrefix"],
			["subjectPrefix", 1, "options.subjectPrefix"],
			["name", 1, "options.name"],
			["user", true, "options.user"],
			["pass", 1, "options.pass"],
			["token", {}, "options.token"],
			["maxReconnectAttempts", "-1", "options.maxReconnectAttempts"],
			["reconnectTimeWait", "2000", "options.reconnectTimeWait"],
			["timeout", null, "options.timeout"],
			["verbose", "yes", "options.verbose"],
			["pedantic", 1, "options.pedantic"],
		])("rejects NATS options.%s = %p naming the field", async (field, value, path) => {
			const cfg = withOptions(nats(), { [field]: value });
			if (value === undefined) delete (cfg.options as Obj)[field];
			await expect(load(cfg)).rejects.toThrow(path);
		});

		it("rejects NATS options.servers = [''] naming the index, not the parent", async () => {
			await expect(load(withOptions(nats(), { servers: [""] }))).rejects.toThrow("options.servers[0]");
		});

		it("includes the file path in validation errors", async () => {
			mockReadFile.mockResolvedValue(JSON.stringify(withRetry(nats(), { jitter: "fixed" })));
			await expect(loadPublisherConfig("./custom-pub.yaml", {})).rejects.toThrow("custom-pub.yaml");
		});
	});

	describe("unimplemented providers", () => {
		it.each([
			["sqs", "options:\n  region: us-east-1\n  queueUrl: https://sqs.amazonaws.com/123/q"],
			["kafka", "options:\n  brokers:\n    - localhost:9092"],
		])("fails fast for provider %p even with a well-formed config", async (provider, options) => {
			mockReadFile.mockResolvedValue(
				`provider: ${provider}\nretryConfig: {numOfAttempts: 3, startingDelayInMs: 100, maxDelayInMs: 1000, jitter: full}\n${options}`,
			);
			await expect(loadPublisherConfig("./publisher.yaml", {})).rejects.toThrow(
				`provider "${provider}" is not implemented yet; only "nats" is supported`,
			);
		});

		it("does not apply NATS env overrides to a non-nats provider", async () => {
			mockReadFile.mockResolvedValue("provider: sqs\nretryConfig: {}\noptions: {}");
			await expect(
				loadPublisherConfig("./publisher.yaml", {
					NATS_SERVERS: "nats://a:4222",
					NATS_SUBJECT_PREFIX: "events",
				}),
			).rejects.toThrow('provider "sqs" is not implemented yet');
		});
	});

	describe("NATS environment overrides", () => {
		type Env = Record<string, string | undefined>;
		const natsOptions = async (env: Env) => {
			const cfg = await loadPublisherConfig("./publisher.yaml", env);
			if (cfg.provider !== "nats") throw new Error("expected nats config");
			return cfg.options;
		};

		beforeEach(() => {
			mockReadFile.mockResolvedValue(
				[
					"provider: nats",
					"retryConfig: {numOfAttempts: 3, startingDelayInMs: 100, maxDelayInMs: 1000, jitter: none}",
					"options:",
					"  servers: nats://yaml:4222",
					"  subjectPrefix: yaml-prefix",
					"  name: yaml-name",
					"  user: yaml-user",
					"  pass: yaml-pass",
					"  timeout: 1234",
				].join("\n"),
			);
		});

		it("keeps yaml values when no env var is set", async () => {
			expect(await natsOptions({})).toEqual({
				servers: "nats://yaml:4222",
				subjectPrefix: "yaml-prefix",
				name: "yaml-name",
				user: "yaml-user",
				pass: "yaml-pass",
				timeout: 1234,
			});
		});

		it("env vars override every mapped yaml option and keep the unmapped ones", async () => {
			const options = await natsOptions({
				NATS_SERVERS: "nats://env:4222",
				NATS_SUBJECT_PREFIX: "env-prefix",
				NATS_USER: "env-user",
				NATS_PASSWORD: "env-pass",
				NATS_TOKEN: "env-token",
				NATS_CONNECTION_NAME: "env-name",
			});
			expect(options).toEqual({
				servers: "nats://env:4222",
				subjectPrefix: "env-prefix",
				name: "env-name",
				user: "env-user",
				pass: "env-pass",
				token: "env-token",
				timeout: 1234,
			});
		});

		it("keeps the yaml retryConfig when overriding options", async () => {
			const cfg = await loadPublisherConfig("./publisher.yaml", { NATS_SERVERS: "nats://env:4222" });
			expect(cfg.retryConfig).toEqual({
				numOfAttempts: 3,
				startingDelayInMs: 100,
				maxDelayInMs: 1000,
				jitter: "none",
			});
		});

		it("maps NATS_PASSWORD to options.pass (not options.password)", async () => {
			const options = await natsOptions({ NATS_PASSWORD: "s3cret" });
			expect(options.pass).toBe("s3cret");
			expect(options).not.toHaveProperty("password");
		});

		it("splits a comma-separated NATS_SERVERS into a trimmed array without empties", async () => {
			const options = await natsOptions({ NATS_SERVERS: " nats://a:4222, ,nats://b:4222 ,," });
			expect(options.servers).toEqual(["nats://a:4222", "nats://b:4222"]);
		});

		it("uses a single string when NATS_SERVERS has one entry", async () => {
			const options = await natsOptions({ NATS_SERVERS: " nats://only:4222 , " });
			expect(options.servers).toBe("nats://only:4222");
		});

		it("uses TARGET_NATS_URL as a deprecated alias when NATS_SERVERS is unset", async () => {
			const options = await natsOptions({ TARGET_NATS_URL: "nats://legacy:4222" });
			expect(options.servers).toBe("nats://legacy:4222");
		});

		it("prefers NATS_SERVERS over TARGET_NATS_URL", async () => {
			const options = await natsOptions({
				NATS_SERVERS: "nats://new:4222",
				TARGET_NATS_URL: "nats://legacy:4222",
			});
			expect(options.servers).toBe("nats://new:4222");
		});

		it("treats empty env vars as unset", async () => {
			const options = await natsOptions({
				NATS_SERVERS: "",
				NATS_SUBJECT_PREFIX: "  ",
				NATS_USER: "",
				TARGET_NATS_URL: "",
			});
			expect(options.servers).toBe("nats://yaml:4222");
			expect(options.subjectPrefix).toBe("yaml-prefix");
			expect(options.user).toBe("yaml-user");
		});

		it("rejects a NATS_SERVERS made only of separators with a message naming the variable", async () => {
			await expect(natsOptions({ NATS_SERVERS: " , ," })).rejects.toThrow("NATS_SERVERS");
		});

		it("validates after overrides, so an invalid yaml value fixed by env is accepted", async () => {
			mockReadFile.mockResolvedValue(
				"provider: nats\nretryConfig: {numOfAttempts: 3, maxDelayInMs: 1000, jitter: full}\noptions:\n  servers: nats://yaml:4222\n  subjectPrefix: ''",
			);
			const options = await natsOptions({ NATS_SUBJECT_PREFIX: "events" });
			expect(options.subjectPrefix).toBe("events");
		});

		it("uses process.env when no env argument is passed", async () => {
			const previous = process.env.NATS_SUBJECT_PREFIX;
			process.env.NATS_SUBJECT_PREFIX = "from-process-env";
			try {
				const cfg = await loadPublisherConfig("./publisher.yaml");
				expect(cfg.provider === "nats" && cfg.options.subjectPrefix).toBe("from-process-env");
			} finally {
				if (previous === undefined) Reflect.deleteProperty(process.env, "NATS_SUBJECT_PREFIX");
				else process.env.NATS_SUBJECT_PREFIX = previous;
			}
		});
	});

	describe("missing config file", () => {
		beforeEach(() => {
			mockReadFile.mockRejectedValue(fsError("ENOENT", "no such file or directory"));
		});

		it("builds a default NATS config from env when servers and subject prefix are set", async () => {
			const cfg = await loadPublisherConfig("./publisher.yaml", {
				NATS_SERVERS: "nats://a:4222,nats://b:4222",
				NATS_SUBJECT_PREFIX: "events",
			});
			expect(cfg).toEqual({
				provider: "nats",
				retryConfig: { numOfAttempts: 5, startingDelayInMs: 500, maxDelayInMs: 5000, jitter: "full" },
				options: {
					name: "outbox-reader",
					maxReconnectAttempts: -1,
					reconnectTimeWait: 2000,
					timeout: 20000,
					servers: ["nats://a:4222", "nats://b:4222"],
					subjectPrefix: "events",
				},
			});
		});

		it("accepts TARGET_NATS_URL and maps credentials and connection name in the fallback", async () => {
			const cfg = await loadPublisherConfig("./publisher.yaml", {
				TARGET_NATS_URL: "nats://legacy:4222",
				NATS_SUBJECT_PREFIX: "events",
				NATS_USER: "u",
				NATS_PASSWORD: "p",
				NATS_TOKEN: "t",
				NATS_CONNECTION_NAME: "my-service",
			});
			expect(cfg.provider === "nats" && cfg.options).toEqual({
				name: "my-service",
				maxReconnectAttempts: -1,
				reconnectTimeWait: 2000,
				timeout: 20000,
				servers: "nats://legacy:4222",
				subjectPrefix: "events",
				user: "u",
				pass: "p",
				token: "t",
			});
		});

		it.each([
			["nothing", {}],
			["only servers", { NATS_SERVERS: "nats://a:4222" }],
			["only the subject prefix", { NATS_SUBJECT_PREFIX: "events" }],
		])("throws a descriptive error naming both options when env has %s", async (_label, env) => {
			const error = await loadPublisherConfig("./conf/publisher.yaml", env).catch((e: Error) => e);
			expect(error).toBeInstanceOf(Error);
			const { message } = error as Error;
			expect(message).toContain('Publisher config file "./conf/publisher.yaml" not found');
			expect(message).toContain("PUBLISHER_CONFIG_PATH");
			expect(message).toContain("NATS_SERVERS and NATS_SUBJECT_PREFIX");
		});

		it("never includes credential values in the error message", async () => {
			const error = await loadPublisherConfig("./publisher.yaml", {
				NATS_SERVERS: "nats://a:4222",
				NATS_PASSWORD: "super-secret",
				NATS_TOKEN: "token-secret",
			}).catch((e: Error) => e);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).not.toContain("super-secret");
			expect((error as Error).message).not.toContain("token-secret");
		});
	});
});
