import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

// mock.module must be declared before the import under test
const mockReadFile = mock(async (_path: string, _enc: string): Promise<string> => "");
mock.module("node:fs/promises", () => ({ readFile: mockReadFile }));

import { loadPublisherConfig } from "../src/publisher-config";

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
		const cfg = await loadPublisherConfig("./publisher.yaml");
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
		const cfg = await loadPublisherConfig("./publisher.yaml");
		if (cfg.provider === "nats") {
			expect(Array.isArray(cfg.options.servers)).toBe(true);
		}
	});

	it("parses SQS config shape", async () => {
		mockReadFile.mockResolvedValue(
			"provider: sqs\nretryConfig: {numOfAttempts: 3, startingDelayInMs: 100, maxDelayInMs: 1000, jitter: full}\noptions:\n  region: us-east-1\n  queueUrl: https://sqs.amazonaws.com/123/q",
		);
		const cfg = await loadPublisherConfig("./publisher.yaml");
		expect(cfg.provider).toBe("sqs");
	});

	it("throws when file cannot be read", async () => {
		mockReadFile.mockRejectedValue(new Error("ENOENT: no such file"));
		await expect(loadPublisherConfig("./missing.yaml")).rejects.toThrow("Failed to read");
	});

	it("error message includes the file path", async () => {
		mockReadFile.mockRejectedValue(new Error("ENOENT"));
		await expect(loadPublisherConfig("./my-config.yaml")).rejects.toThrow("my-config.yaml");
	});

	it("throws on unknown provider", async () => {
		mockReadFile.mockResolvedValue("provider: rabbitmq\nretryConfig: {}\noptions: {}");
		await expect(loadPublisherConfig("./publisher.yaml")).rejects.toThrow("rabbitmq");
	});

	it("throws on invalid YAML", async () => {
		// Spy on the global so we can simulate a parse error
		const parseSpy = spyOn(Bun.YAML, "parse").mockImplementation(() => {
			throw new SyntaxError("unexpected token");
		});
		mockReadFile.mockResolvedValue("anything");
		await expect(loadPublisherConfig("./publisher.yaml")).rejects.toThrow("Failed to parse");
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
		const sqs = (): Obj => ({
			provider: "sqs",
			retryConfig: retry(),
			options: { region: "us-east-1", queueUrl: "https://sqs.amazonaws.com/123/q" },
		});
		const kafka = (): Obj => ({
			provider: "kafka",
			retryConfig: retry(),
			options: { brokers: ["localhost:9092"] },
		});

		// JSON is valid YAML, so fixtures can be expressed as plain objects
		const load = (cfg: unknown) => {
			mockReadFile.mockResolvedValue(JSON.stringify(cfg));
			return loadPublisherConfig("./publisher.yaml");
		};
		const withRetry = (base: Obj, patch: Obj): Obj => ({
			...base,
			retryConfig: { ...(base.retryConfig as Obj), ...patch },
		});
		const withOptions = (base: Obj, patch: Obj): Obj => ({
			...base,
			options: { ...(base.options as Obj), ...patch },
		});

		it("accepts valid configs for every provider and returns them unchanged", async () => {
			for (const cfg of [nats(), sqs(), kafka()]) {
				expect(await load(cfg)).toEqual(cfg as never);
			}
		});

		it("accepts jitter 'none' and a config without startingDelayInMs", async () => {
			const cfg = withRetry(nats(), { jitter: "none" });
			delete (cfg.retryConfig as Obj).startingDelayInMs;
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
			await expect(loadPublisherConfig("./publisher.yaml")).rejects.toThrow(/Unknown publisher provider/);
		});

		it("throws when retryConfig is missing", async () => {
			const cfg = nats();
			delete cfg.retryConfig;
			await expect(load(cfg)).rejects.toThrow('"retryConfig" must be an object');
		});

		it("throws when options is missing", async () => {
			const cfg = sqs();
			delete cfg.options;
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
			const cfg = withRetry(kafka(), { [field]: value });
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

		it.each([
			["region", undefined, "options.region"],
			["region", "", "options.region"],
			["queueUrl", undefined, "options.queueUrl"],
			["queueUrl", 123, "options.queueUrl"],
		])("rejects SQS options.%s = %p naming the field", async (field, value, path) => {
			const cfg = withOptions(sqs(), { [field]: value });
			if (value === undefined) delete (cfg.options as Obj)[field];
			await expect(load(cfg)).rejects.toThrow(path);
		});

		it.each([
			["brokers", undefined, "options.brokers"],
			["brokers", "localhost:9092", "options.brokers"],
			["brokers", [], "options.brokers"],
			["brokers", ["localhost:9092", 9093], "options.brokers[1]"],
			["clientId", 5, "options.clientId"],
		])("rejects Kafka options.%s = %p naming the field", async (field, value, path) => {
			const cfg = withOptions(kafka(), { [field]: value });
			if (value === undefined) delete (cfg.options as Obj)[field];
			await expect(load(cfg)).rejects.toThrow(path);
		});

		it("includes the file path in validation errors", async () => {
			mockReadFile.mockResolvedValue(JSON.stringify(withRetry(nats(), { jitter: "fixed" })));
			await expect(loadPublisherConfig("./custom-pub.yaml")).rejects.toThrow("custom-pub.yaml");
		});
	});
});
