import type { ArgumentsCamelCase, Argv } from "yargs";
import { ReplicationSetupService } from "../../../services/replication-setup";
import type { ReplicationSetupOptions } from "../../../types/replication-config";
import {
	REPLICATION_DOCS_URL,
	getReplicationErrorHints,
	getReplicationNextSteps,
} from "../../../utils/replication-messages";

const PREREQUISITES = `
Prerequisites (configure these on the PostgreSQL server first):

  postgresql.conf (requires a server restart):
    wal_level = logical
    max_wal_senders = 10        (minimum: 1)
    max_replication_slots = 10  (minimum: 1)

  The wal2json output plugin must be installed on the server
  (e.g. apt install postgresql-<version>-wal2json).

  The PostgreSQL user must have the LOGIN and REPLICATION roles.

Full guide: ${REPLICATION_DOCS_URL}
---`;

interface SetupReplicationArgs {
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
	"slot-name": string;
}

export const command = "replication";
export const describe = "Create a PostgreSQL logical replication slot";

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
			description:
				"PostgreSQL password. Prefer the PGPASSWORD env var: command-line arguments are visible to other users (e.g. in `ps`)",
			default: process.env.PGPASSWORD,
			defaultDescription: "$PGPASSWORD",
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
		} else {
			console.log(`Replication slot "${result.slotName}" created successfully.`);
		}

		console.log(`\n${getReplicationNextSteps(result.slotName).join("\n")}`);
		process.exit(0);
	} catch (error) {
		console.error("Failed to create replication slot:", error instanceof Error ? error.message : error);
		for (const hint of getReplicationErrorHints(error)) {
			console.error(hint);
		}
		process.exit(1);
	}
}
