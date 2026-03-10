import type { ArgumentsCamelCase, Argv } from "yargs";
import { PrismaSchemaGenerator } from "../../../services/prisma-schema-generator";

interface CreateConfigArgs {
	output: string;
}

export const command = "config";
export const describe = "Generate a sample configuration file";

export function builder(yargs: Argv): Argv<CreateConfigArgs> {
	return yargs.option("output", {
		alias: "o",
		type: "string",
		description: "Output path for the config file",
		default: "./outbox-config.json",
	}) as Argv<CreateConfigArgs>;
}

export function handler(argv: ArgumentsCamelCase<CreateConfigArgs>): void {
	PrismaSchemaGenerator.generateConfigFile(argv.output);
}
