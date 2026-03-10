import type { ArgumentsCamelCase, Argv } from "yargs";
import { ReplicationSetupService } from "../services/replication-setup";
import type { ReplicationSetupOptions } from "../types/replication-config";

const PREREQUISITES = `
The following settings must be set in postgresql.conf (requires server restart):

  wal_level = logical
  max_wal_senders = 10        (minimum: 1)
  max_replication_slots = 10  (minimum: 1)

The PostgreSQL user must have LOGIN and REPLICATION roles.
See pg.conf in this repository for a complete example configuration.
---`;

interface SetupReplicationArgs {
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
	"slot-name": string;
}

export const command = "setup-replication";
export const describe = "Create a PostgreSQL logical replication slot using the wal2json plugin";

export function builder(yargs: Argv) {
	return yargs
		.option("host", {
			alias: "h",
			type: "string",
			description: "PostgreSQL host",
			default: "localhost",
		})
		.option("port", {
			alias: "p",
			type: "number",
			description: "PostgreSQL port",
			default: 5432,
		})
		.option("user", {
			alias: "u",
			type: "string",
			description: "PostgreSQL user",
			demandOption: true,
		})
		.option("password", {
			alias: "P",
			type: "string",
			description: "PostgreSQL password (or set PGPASSWORD env var)",
			default: process.env.PGPASSWORD,
			demandOption: !process.env.PGPASSWORD,
		})
		.option("database", {
			alias: "d",
			type: "string",
			description: "PostgreSQL database",
			demandOption: true,
		})
		.option("slot-name", {
			alias: "s",
			type: "string",
			description: "Replication slot name",
			demandOption: true,
		});
}

export async function handler(argv: ArgumentsCamelCase<SetupReplicationArgs>): Promise<void> {
	console.log(PREREQUISITES);

	const options: ReplicationSetupOptions = {
		host: argv.host,
		port: argv.port,
		user: argv.user,
		password: argv.password as string,
		database: argv.database,
		slotName: argv.slotName,
	};

	const service = new ReplicationSetupService();

	try {
		const result = await service.setup(options);

		if (result.alreadyExists) {
			console.log(`Replication slot "${result.slotName}" already exists. Nothing to do.`);
			process.exit(0);
		}

		console.log(`Replication slot "${result.slotName}" created successfully.`);
		process.exit(0);
	} catch (error) {
		console.error("Failed to create replication slot:", error instanceof Error ? error.message : error);
		console.error("Ensure the PostgreSQL user has the REPLICATION role.");
		process.exit(1);
	}
}
