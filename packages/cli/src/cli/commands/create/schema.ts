import type { ArgumentsCamelCase, Argv } from "yargs";
import { PrismaSchemaGenerator } from "../../../services/prisma-schema-generator";
import type { SchemaGenerationConfig } from "../../../types/schema-config";
import type { ColumnNaming } from "../../../utils/column-naming";

interface CreateSchemaArgs {
	schemaPath: string;
	modelName: string;
	tableName: string;
	config?: string;
	columnNaming: ColumnNaming;
}

export const command = "schema";
export const describe = "Add the outbox model to your Prisma schema";

export function builder(yargs: Argv): Argv<CreateSchemaArgs> {
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
		.option("config", {
			alias: "c",
			type: "string",
			description: "Path to configuration file",
		})
		.option("column-naming", {
			type: "string",
			description: "Column naming convention",
			choices: ["snake_case", "camelCase", "PascalCase"] as const,
			default: "snake_case",
		}) as unknown as Argv<CreateSchemaArgs>;
}

export async function handler(argv: ArgumentsCamelCase<CreateSchemaArgs>): Promise<void> {
	try {
		const config: SchemaGenerationConfig = {
			schemaPath: argv.schemaPath,
			modelName: argv.modelName,
			tableName: argv.tableName,
			generateMigration: false,
			columnNaming: argv.columnNaming,
		};

		const generator = new PrismaSchemaGenerator({
			config,
			configPath: argv.config,
		});

		await generator.generateSchema();
	} catch (error) {
		console.error("Error generating schema:", error);
		process.exit(1);
	}
}
