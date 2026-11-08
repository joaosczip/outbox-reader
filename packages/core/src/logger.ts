import { SeverityNumber, logs } from "@opentelemetry/api-logs";
import pino from "pino";

type LogData = {
	message: string;
	traceId?: string;
	extra?: Record<string, unknown>;
};

const OTEL_LOGGER_NAME = "outbox-reader";

function toAttributes(data: Record<string, unknown>): Record<string, string | number | boolean> {
	const attrs: Record<string, string | number | boolean> = {};
	for (const [k, v] of Object.entries(data)) {
		if (v === null || v === undefined) continue;
		if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
			attrs[k] = v;
		} else {
			attrs[k] = JSON.stringify(v);
		}
	}
	return attrs;
}

export type LoggerOptions = {
	/** Alternative pino destination (defaults to stdout). Mainly for tests. */
	destination?: pino.DestinationStream;
};

type Level = "debug" | "info" | "warn" | "error";

const SEVERITY: Record<Level, { number: SeverityNumber; text: string }> = {
	debug: { number: SeverityNumber.DEBUG, text: "DEBUG" },
	info: { number: SeverityNumber.INFO, text: "INFO" },
	warn: { number: SeverityNumber.WARN, text: "WARN" },
	error: { number: SeverityNumber.ERROR, text: "ERROR" },
};

/**
 * pino logger that mirrors every enabled entry as an OpenTelemetry log record.
 * Disabled levels (per LOG_LEVEL) are cheap no-ops: neither the pino object nor the
 * OTel attributes (which JSON.stringify non-primitive values) are built.
 */
export class Logger {
	private logger: pino.Logger;

	constructor(context?: string, { destination }: LoggerOptions = {}) {
		const options: pino.LoggerOptions = {
			name: context,
			level: process.env.LOG_LEVEL || "info",
			formatters: {
				level: (label, _) => ({
					level: label,
				}),
			},
			messageKey: "message",
			timestamp: pino.stdTimeFunctions.isoTime,
		};
		this.logger = destination ? pino(options, destination) : pino(options);
	}

	isLevelEnabled(level: Level): boolean {
		return this.logger.isLevelEnabled(level);
	}

	debug(data: LogData) {
		this.log("debug", data);
	}

	info(data: LogData) {
		this.log("info", data);
	}

	warn(data: LogData) {
		this.log("warn", data);
	}

	error({ error, ...data }: LogData & { error: unknown }) {
		this.log("error", data, error, true);
	}

	private log(level: Level, { message, extra, traceId }: LogData, error?: unknown, withError = false) {
		if (!this.logger.isLevelEnabled(level)) return;

		this.logger[level](withError ? { message, traceId, ...extra, err: error } : { message, traceId, ...extra });
		logs.getLogger(OTEL_LOGGER_NAME).emit({
			severityNumber: SEVERITY[level].number,
			severityText: SEVERITY[level].text,
			body: message,
			attributes: {
				...(traceId ? { traceId } : {}),
				...toAttributes(extra ?? {}),
				...(withError ? errorAttributes(error) : {}),
			},
		});
	}
}

function errorAttributes(error: unknown): Record<string, string> {
	if (error instanceof Error) return { "error.type": error.name, "error.message": error.message };
	if (error != null) return { "error.raw": String(error) };
	return {};
}
