import pino from "pino";

type LogData = {
	message: string;
	traceId?: string;
	extra?: Record<string, unknown>;
};

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
	}

	error({ message, extra, traceId, error }: LogData & { error: unknown }) {
		this.logger.error({ message, traceId, ...extra, err: error });
	}

	warn({ message, extra, traceId }: LogData) {
		this.logger.warn({ message, traceId, ...extra });
	}

	debug({ message, extra, traceId }: LogData) {
		this.logger.debug({ message, traceId, ...extra });
	}
}
