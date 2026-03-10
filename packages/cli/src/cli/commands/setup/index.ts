import type { Argv } from "yargs";
import * as replication from "./replication";

export const command = "setup <command>";
export const describe = "Configure infrastructure for the outbox pattern";

export function builder(yargs: Argv) {
	return yargs.command(replication).demandCommand(1).strict();
}

export function handler() {}
