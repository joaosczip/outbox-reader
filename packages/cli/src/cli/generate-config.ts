import type { ArgumentsCamelCase, Argv } from "yargs";
import { PrismaSchemaGenerator } from "../services/prisma-schema-generator";

interface GenerateConfigArgs {
	output: string;
}

export const command = "generate-config";
export const describe = "Generate a sample configuration file";

export function builder(yargs: Argv): Argv<GenerateConfigArgs> {
	return yargs.option("output", {
		alias: "o",
		type: "string",
		description: "Output path for the config file",
		default: "./outbox-config.json",
	}) as Argv<GenerateConfigArgs>;
}

export function handler(argv: ArgumentsCamelCase<GenerateConfigArgs>): void {
	PrismaSchemaGenerator.generateConfigFile(argv.output);
}
