#!/usr/bin/env node

// This is a runtime wrapper that uses bun to run the TypeScript CLI
const { execSync } = require("child_process");
const path = require("path");

const cliPath = path.join(__dirname, "..", "src", "cli", "index.ts");
const args = process.argv.slice(2).map((a) => JSON.stringify(a)).join(" ");

try {
	execSync(`bun ${cliPath} ${args}`, { stdio: "inherit" });
} catch (error) {
	process.exit(error.status || 1);
}
