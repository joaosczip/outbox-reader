import { type Mock, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { type LogRecord, SeverityNumber, logs } from "@opentelemetry/api-logs";

import { Logger } from "../src/logger";

type Emit = (record: LogRecord) => void;

/** Captures pino's serialized output lines instead of writing to stdout. */
class CapturingDestination {
	public lines: Array<Record<string, unknown>> = [];

	write(chunk: string): void {
		this.lines.push(JSON.parse(chunk));
	}
}

describe("Logger", () => {
	const originalLogLevel = process.env.LOG_LEVEL;
	let emit: Mock<Emit>;
	let getLoggerSpy: ReturnType<typeof spyOn>;
	let destination: CapturingDestination;

	const buildLogger = (level: string) => {
		process.env.LOG_LEVEL = level;
		return new Logger("test", { destination });
	};

	beforeEach(() => {
		emit = mock<Emit>(() => {});
		getLoggerSpy = spyOn(logs, "getLogger").mockReturnValue({ emit } as never);
		destination = new CapturingDestination();
	});

	afterEach(() => {
		getLoggerSpy.mockRestore();
		process.env.LOG_LEVEL = originalLogLevel;
	});

	describe("debug", () => {
		it("writes to pino and emits an OTel DEBUG record when LOG_LEVEL=debug", () => {
			const logger = buildLogger("debug");

			logger.debug({ message: "hello", traceId: "t-1", extra: { recordId: "r-1", nested: { a: 1 } } });

			expect(destination.lines).toHaveLength(1);
			expect(destination.lines[0]).toMatchObject({
				level: "debug",
				message: "hello",
				traceId: "t-1",
				recordId: "r-1",
				nested: { a: 1 },
			});
			expect(emit).toHaveBeenCalledTimes(1);
			expect(emit.mock.calls[0][0]).toEqual({
				severityNumber: SeverityNumber.DEBUG,
				severityText: "DEBUG",
				body: "hello",
				attributes: { traceId: "t-1", recordId: "r-1", nested: '{"a":1}' },
			});
		});

		it("is a no-op for pino and OTel when LOG_LEVEL=info", () => {
			const logger = buildLogger("info");

			logger.debug({ message: "hello", extra: { recordId: "r-1" } });

			expect(destination.lines).toHaveLength(0);
			expect(emit).not.toHaveBeenCalled();
			expect(getLoggerSpy).not.toHaveBeenCalled();
		});

		it("does not serialize extra attributes when disabled", () => {
			const logger = buildLogger("info");
			const toJSON = mock(() => ({}));

			logger.debug({ message: "hello", extra: { heavy: { toJSON } } });

			expect(toJSON).not.toHaveBeenCalled();
		});
	});

	describe("level guards", () => {
		it("skips info and warn (pino and OTel) when LOG_LEVEL=error, but still emits error", () => {
			const logger = buildLogger("error");

			logger.info({ message: "i" });
			logger.warn({ message: "w" });
			logger.error({ message: "e", error: new Error("boom") });

			expect(destination.lines.map((l) => l.message)).toEqual(["e"]);
			expect(emit).toHaveBeenCalledTimes(1);
			expect(emit.mock.calls[0][0]).toMatchObject({
				severityNumber: SeverityNumber.ERROR,
				body: "e",
				attributes: { "error.type": "Error", "error.message": "boom" },
			});
		});

		it("skips everything when LOG_LEVEL=silent", () => {
			const logger = buildLogger("silent");

			logger.debug({ message: "d" });
			logger.info({ message: "i" });
			logger.warn({ message: "w" });
			logger.error({ message: "e", error: new Error("boom") });

			expect(destination.lines).toHaveLength(0);
			expect(emit).not.toHaveBeenCalled();
		});

		it("emits info and warn with their OTel severities at the default level", () => {
			const logger = buildLogger("info");

			logger.info({ message: "i", extra: { a: 1 } });
			logger.warn({ message: "w" });

			expect(destination.lines.map((l) => [l.level, l.message])).toEqual([
				["info", "i"],
				["warn", "w"],
			]);
			expect(emit.mock.calls.map(([r]) => [r.severityNumber, r.severityText, r.body])).toEqual([
				[SeverityNumber.INFO, "INFO", "i"],
				[SeverityNumber.WARN, "WARN", "w"],
			]);
		});

		it("exposes isLevelEnabled for callers that build expensive log data", () => {
			const logger = buildLogger("info");

			expect(logger.isLevelEnabled("debug")).toBe(false);
			expect(logger.isLevelEnabled("info")).toBe(true);
			expect(logger.isLevelEnabled("error")).toBe(true);
		});
	});
});
