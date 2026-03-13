import type { Argv } from "yargs";
import * as migration from "./migration";
import * as schema from "./schema";

export const command = "create <command>";
export const describe = "Create outbox artifacts";

export function builder(yargs: Argv) {
	return yargs.command(schema).command(migration).demandCommand(1).strict();
}

export function handler() {}
