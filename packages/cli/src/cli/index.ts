#!/usr/bin/env bun

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import packageJson from "../../package.json";
import * as create from "./commands/create/index";
import * as setup from "./commands/setup/index";

yargs(hideBin(process.argv))
	.scriptName("outy")
	.command(create)
	.command(setup)
	.demandCommand(1)
	.strict()
	.help()
	.version(packageJson.version)
	.parseAsync();
