import type { ArgumentsCamelCase, Argv } from "yargs";
import { createMigrationAdapter } from "../../../services/migration-adapter";
import type { MigrationTarget } from "../../../types/migration-adapter-config";
import type { ColumnNaming } from "../../../utils/column-naming";

interface CreateMigrationArgs {
	target?: MigrationTarget;
	schemaPath: string;
	modelName: string;
	tableName: string;
	migrationName: string;
	config?: string;
	migrationsPath?: string;
	output?: string;
	columnNaming: ColumnNaming;
}

export const command = "migration";
export const describe = "Generate a database migration for the outbox table";

export function builder(yargs: Argv): Argv<CreateMigrationArgs> {
	return yargs
		.option("target", {
			alias: "T",
			type: "string",
			description: "Migration target ORM/format",
			choices: ["prisma", "sequelize", "sql"] as const,
		})
		.option("schema-path", {
			alias: "s",
			type: "string",
			description: "Path to schema.prisma file (Prisma only)",
			default: "./prisma/schema.prisma",
		})
		.option("model-name", {
			alias: "m",
			type: "string",
			description: "Name of the outbox model (Prisma only)",
			default: "OutboxRecord",
		})
		.option("table-name", {
			alias: "t",
			type: "string",
			description: "Name of the database table",
			default: "outbox",
		})
		.option("migration-name", {
			type: "string",
			description: "Name for the migration",
			default: "add_outbox_table",
		})
		.option("config", {
			alias: "c",
			type: "string",
			description: "Path to configuration file",
		})
		.option("migrations-path", {
			type: "string",
			description: "Path to migrations directory (Sequelize only)",
		})
		.option("output", {
			alias: "o",
			type: "string",
			description: "Output file path for SQL (SQL only, defaults to stdout)",
		})
		.option("column-naming", {
			type: "string",
			description: "Column naming convention",
			choices: ["snake_case", "camelCase", "PascalCase"] as const,
			default: "snake_case",
		}) as unknown as Argv<CreateMigrationArgs>;
}

export async function handler(argv: ArgumentsCamelCase<CreateMigrationArgs>): Promise<void> {
	try {
		const adapter = createMigrationAdapter(argv.target);

		const target = argv.target ?? "sql";

		if (target === "prisma") {
			await adapter.createMigration({
				target: "prisma",
				schemaPath: argv.schemaPath,
				modelName: argv.modelName,
				tableName: argv.tableName,
				migrationName: argv.migrationName,
				configPath: argv.config,
				columnNaming: argv.columnNaming,
			});
		} else if (target === "sequelize") {
			await adapter.createMigration({
				target: "sequelize",
				migrationsPath: argv.migrationsPath,
				migrationName: argv.migrationName,
				tableName: argv.tableName,
				configPath: argv.config,
				columnNaming: argv.columnNaming,
			});
		} else {
			await adapter.createMigration({
				target: "sql",
				tableName: argv.tableName,
				output: argv.output,
				columnNaming: argv.columnNaming,
			});
		}
	} catch (error) {
		console.error("Error generating migration:", error);
		process.exit(1);
	}
}
