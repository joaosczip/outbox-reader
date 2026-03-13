export class MockLogger {
	public logs: Array<{ level: string; message: string; extra?: unknown; error?: unknown }> = [];

	info({ message, extra }: { message: string; extra?: unknown }): void {
		this.logs.push({ level: "info", message, extra });
	}

	warn({ message, extra }: { message: string; extra?: unknown }): void {
		this.logs.push({ level: "warn", message, extra });
	}

	error({ message, extra, error }: { message: string; extra?: unknown; error?: unknown }): void {
		this.logs.push({ level: "error", message, extra, error });
	}
}
