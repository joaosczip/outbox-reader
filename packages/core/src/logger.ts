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

export class Logger {
	private logger: pino.Logger;

	constructor(context?: string) {
		this.logger = pino({
			name: context,
			level: process.env.LOG_LEVEL || "info",
			formatters: {
				level: (label, _) => ({
					level: label,
				}),
			},
			messageKey: "message",
			timestamp: pino.stdTimeFunctions.isoTime,
		});
	}

	info({ message, extra, traceId }: LogData) {
		this.logger.info({ message, traceId, ...extra });
		logs.getLogger(OTEL_LOGGER_NAME).emit({
			severityNumber: SeverityNumber.INFO,
			severityText: "INFO",
			body: message,
			attributes: { ...(traceId ? { traceId } : {}), ...toAttributes(extra ?? {}) },
		});
	}

	error({ message, extra, traceId, error }: LogData & { error: unknown }) {
		this.logger.error({ message, traceId, ...extra, err: error });
		logs.getLogger(OTEL_LOGGER_NAME).emit({
			severityNumber: SeverityNumber.ERROR,
			severityText: "ERROR",
			body: message,
			attributes: {
				...(traceId ? { traceId } : {}),
				...toAttributes(extra ?? {}),
				...(error instanceof Error
					? { "error.type": error.name, "error.message": error.message }
					: error != null
						? { "error.raw": String(error) }
						: {}),
			},
		});
	}

	warn({ message, extra, traceId }: LogData) {
		this.logger.warn({ message, traceId, ...extra });
		logs.getLogger(OTEL_LOGGER_NAME).emit({
			severityNumber: SeverityNumber.WARN,
			severityText: "WARN",
			body: message,
			attributes: { ...(traceId ? { traceId } : {}), ...toAttributes(extra ?? {}) },
		});
	}

	debug({ message, extra, traceId }: LogData) {
		this.logger.debug({ message, traceId, ...extra });
		logs.getLogger(OTEL_LOGGER_NAME).emit({
			severityNumber: SeverityNumber.DEBUG,
			severityText: "DEBUG",
			body: message,
			attributes: { ...(traceId ? { traceId } : {}), ...toAttributes(extra ?? {}) },
		});
	}
}
