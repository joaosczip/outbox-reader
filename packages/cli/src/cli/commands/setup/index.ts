import type { Argv } from "yargs";
import * as client from "./client";
import * as replication from "./replication";

export const command = "setup <command>";
export const describe = "Configure infrastructure for the outbox pattern";

export function builder(yargs: Argv) {
	return yargs.command(client).command(replication).demandCommand(1).strict();
}

export function handler() {}
