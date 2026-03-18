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
			"provider: nats\nretryConfig: {numOfAttempts: 3, startingDelayInMs: 100, maxDelayInMs: 1000, jitter: full}\noptions:\n  servers:\n    - nats://a:4222\n    - nats://b:4222",
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
});
