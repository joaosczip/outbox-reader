#!/usr/bin/env node

const { execSync } = require("node:child_process");
const path = require("node:path");

const cliPath = path.join(__dirname, "..", "dist", "src", "cli", "index.js");
const args = process.argv
	.slice(2)
	.map((a) => JSON.stringify(a))
	.join(" ");

try {
	execSync(`bun ${cliPath} ${args}`, { stdio: "inherit" });
} catch (error) {
	process.exit(error.status || 1);
}
