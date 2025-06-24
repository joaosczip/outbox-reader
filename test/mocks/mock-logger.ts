export class MockLogger {
	public logs: Array<{ level: string; message: string; extra?: any; error?: any }> = [];

	info({ message, extra }: { message: string; extra?: any }): void {
		this.logs.push({ level: "info", message, extra });
	}

	warn({ message, extra }: { message: string; extra?: any }): void {
		this.logs.push({ level: "warn", message, extra });
	}

	error({ message, extra, error }: { message: string; extra?: any; error?: any }): void {
		this.logs.push({ level: "error", message, extra, error });
	}
}
