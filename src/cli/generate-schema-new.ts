#!/usr/bin/env node

import { Command } from "commander";
import { PrismaSchemaGenerator } from "../services/prisma-schema-generator";
import type { SchemaGenerationConfig } from "../types/schema-config";

const program = new Command();

program.name("outbox-schema").description("Outbox Reader - Prisma Schema Generator").version("1.0.0");

program
	.option("-s, --schema-path <path>", "Path to schema.prisma file", "./prisma/schema.prisma")
	.option("-m, --model-name <name>", "Name of the outbox model", "OutboxRecord")
	.option("-t, --table-name <name>", "Name of the database table", "outbox")
	.option("--migration-name <name>", "Name for the migration", "add_outbox_table")
	.option("-c, --config <path>", "Path to configuration file")
	.option("--skip-migration", "Skip migration generation", false)
	.action(async (options) => {
		try {
			const config: SchemaGenerationConfig = {
				schemaPath: options.schemaPath,
				modelName: options.modelName,
				tableName: options.tableName,
				migrationName: options.migrationName,
				generateMigration: !options.skipMigration,
			};

			const generator = new PrismaSchemaGenerator({
				config,
				configPath: options.config,
			});

			await generator.generate();
		} catch (error) {
			console.error("❌ Error generating schema:", error);
			process.exit(1);
		}
	});

program
	.command("generate-config")
	.description("Generate a sample configuration file")
	.option("-o, --output <path>", "Output path for the config file", "./outbox-config.json")
	.action((options) => {
		PrismaSchemaGenerator.generateConfigFile(options.output);
	});

program.addHelpText(
	"after",
	`
Examples:
  $ outbox-schema                                    Generate schema with defaults
  $ outbox-schema -s ./database/schema.prisma       Generate schema with custom path
  $ outbox-schema -c ./outbox-config.json           Generate schema using config file
  $ outbox-schema generate-config                   Generate a sample config file
  $ outbox-schema --skip-migration                  Generate schema without migration
`,
);

async function main(): Promise<void> {
	await program.parseAsync(process.argv);
}

// Only run if this file is executed directly
if (require.main === module) {
	main().catch((error) => {
		console.error("❌ Unexpected error:", error);
		process.exit(1);
	});
}

export { main as generateOutboxSchema };
