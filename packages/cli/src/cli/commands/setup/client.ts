import type { Argv } from "yargs";
import { ClientInstaller } from "../../../services/client-installer";

export const command = "client";
export const describe = "Install the @outbox-reader/client package";

export function builder(yargs: Argv) {
	return yargs;
}

export async function handler(): Promise<void> {
	const installer = new ClientInstaller();

	try {
		const result = await installer.install();
		console.log(`\n@outbox-reader/client installed successfully via ${result.packageManager}.`);
		process.exit(0);
	} catch (error) {
		console.error("Failed to install @outbox-reader/client:", error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
