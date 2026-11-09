import type { Argv } from "yargs";
import { CLIENT_PACKAGE_NAME, ClientInstaller } from "../../../services/client-installer";

export const command = "client";
export const describe = `Install the ${CLIENT_PACKAGE_NAME} package into the current project`;

export function builder(yargs: Argv) {
	return yargs;
}

export async function handler(): Promise<void> {
	const installer = new ClientInstaller();

	try {
		const result = await installer.install();
		console.log(`\n${CLIENT_PACKAGE_NAME} installed successfully via ${result.packageManager}.`);
		process.exit(0);
	} catch (error) {
		console.error(`Failed to install ${CLIENT_PACKAGE_NAME}:`, error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
