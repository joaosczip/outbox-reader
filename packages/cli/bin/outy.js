#!/usr/bin/env node

// The CLI is built for the Bun runtime; this launcher lets `outy` start from
// any shell (npx, npm bin links) and hands off to `bun`. Arguments are passed
// as an argv array (no shell), so values such as `pa$$word` reach the CLI
// literally.

const { spawnSync } = require("node:child_process");
const path = require("node:path");

// OUTY_CLI_PATH is only meant for tests of this launcher.
const cliPath = process.env.OUTY_CLI_PATH || path.join(__dirname, "..", "dist", "src", "cli", "index.js");

const result = spawnSync("bun", [cliPath, ...process.argv.slice(2)], { stdio: "inherit" });

if (result.error) {
	if (result.error.code === "ENOENT") {
		console.error("outy requires Bun >= 1.2, but the `bun` executable was not found on your PATH.");
		console.error("Install Bun from https://bun.sh and try again.");
	} else {
		console.error(`outy: failed to start bun: ${result.error.message}`);
	}
	process.exit(1);
}

if (result.signal) {
	process.kill(process.pid, result.signal);
} else {
	process.exit(result.status ?? 1);
}
