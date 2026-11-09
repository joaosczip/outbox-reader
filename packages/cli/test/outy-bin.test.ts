import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const binPath = path.join(import.meta.dir, "..", "bin", "outy.js");
const echoCliPath = path.join(import.meta.dir, "fixtures", "echo-cli.js");

interface RunResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

function runBin(args: string[], env: Record<string, string | undefined>): RunResult {
	const result = Bun.spawnSync([process.execPath, binPath, ...args], {
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

describe("bin/outy.js", () => {
	let env: Record<string, string | undefined>;

	beforeEach(() => {
		env = { OUTY_CLI_PATH: echoCliPath, ECHO_CLI_EXIT_CODE: "0", HOME: "/home/should-not-expand" };
	});

	it("passes arguments to the CLI literally, without shell expansion (regression)", () => {
		const args = [
			"setup",
			"replication",
			"-P",
			"pa$$word$HOME",
			"`whoami`",
			"a b",
			"it's",
			'"quoted"',
			"$(echo hi)",
		];

		const result = runBin(args, env);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.trim())).toEqual(args);
		expect(result.stdout).not.toContain("/home/should-not-expand");
	});

	it("propagates the CLI exit code", () => {
		env.ECHO_CLI_EXIT_CODE = "3";

		const result = runBin(["create", "schema"], env);

		expect(result.exitCode).toBe(3);
	});

	describe("when bun is not installed", () => {
		let emptyPathDir: string;

		beforeAll(() => {
			emptyPathDir = fs.mkdtempSync(path.join(os.tmpdir(), "outy-no-bun-"));
		});

		afterAll(() => {
			fs.rmSync(emptyPathDir, { recursive: true, force: true });
		});

		it("prints a clear message about the Bun requirement and exits with 1", () => {
			env.PATH = emptyPathDir;

			const result = runBin(["--help"], env);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("requires Bun >= 1.2");
			expect(result.stderr).toContain("https://bun.sh");
			expect(result.stdout).toBe("");
		});
	});
});
