#!/usr/bin/env bun

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import * as generateConfig from "./generate-config";
import * as generateSchema from "./generate-schema";
import * as setupReplication from "./setup-replication";

yargs(hideBin(process.argv))
	.scriptName("outbox-schema")
	.command(generateSchema)
	.command(generateConfig)
	.command(setupReplication)
	.demandCommand(1)
	.strict()
	.help()
	.version("1.0.0")
	.parseAsync();
