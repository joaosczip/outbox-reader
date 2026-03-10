#!/usr/bin/env bun

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import * as create from "./commands/create/index";
import * as setup from "./commands/setup/index";

yargs(hideBin(process.argv))
	.scriptName("outbox")
	.command(create)
	.command(setup)
	.demandCommand(1)
	.strict()
	.help()
	.version("1.0.0")
	.parseAsync();
