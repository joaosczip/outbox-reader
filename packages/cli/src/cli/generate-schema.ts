import type { ArgumentsCamelCase, Argv } from "yargs";
import { PrismaSchemaGenerator } from "../services/prisma-schema-generator";
import type { SchemaGenerationConfig } from "../types/schema-config";

interface GenerateSchemaArgs {
	schemaPath: string;
	modelName: string;
	tableName: string;
	migrationName: string;
	config?: string;
	skipMigration: boolean;
}

export const command = ["schema", "$0"];
export const describe = "Generate Prisma schema and migration for the outbox table";

export function builder(yargs: Argv): Argv<GenerateSchemaArgs> {
	return yargs
		.option("schema-path", {
			alias: "s",
			type: "string",
			description: "Path to schema.prisma file",
			default: "./prisma/schema.prisma",
		})
		.option("model-name", {
			alias: "m",
			type: "string",
			description: "Name of the outbox model",
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
		.option("skip-migration", {
			type: "boolean",
			description: "Skip migration generation",
			default: false,
		}) as Argv<GenerateSchemaArgs>;
}

export async function handler(argv: ArgumentsCamelCase<GenerateSchemaArgs>): Promise<void> {
	try {
		const config: SchemaGenerationConfig = {
			schemaPath: argv.schemaPath,
			modelName: argv.modelName,
			tableName: argv.tableName,
			migrationName: argv.migrationName,
			generateMigration: !argv.skipMigration,
		};

		const generator = new PrismaSchemaGenerator({
			config,
			configPath: argv.config,
		});

		await generator.generate();
	} catch (error) {
		console.error("Error generating schema:", error);
		process.exit(1);
	}
}
