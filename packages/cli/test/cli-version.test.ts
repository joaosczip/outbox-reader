import { beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";
import packageJson from "../package.json";

const cliEntry = path.join(import.meta.dir, "..", "src", "cli", "index.ts");

describe("outy --version", () => {
	let output: string;
	let exitCode: number | null;

	beforeAll(() => {
		const result = Bun.spawnSync([process.execPath, cliEntry, "--version"], { stdout: "pipe", stderr: "pipe" });
		output = result.stdout.toString().trim();
		exitCode = result.exitCode;
	});

	it("prints the version from package.json (regression: was hardcoded to 1.0.0)", () => {
		expect(exitCode).toBe(0);
		expect(output).toBe(packageJson.version);
	});
});
