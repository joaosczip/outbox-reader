import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import fs from "node:fs";
import { ClientInstaller, type ShellExecutor } from "../src/services/client-installer";

describe("ClientInstaller", () => {
	let executedCommands: string[][];
	let shellExecutor: ShellExecutor;

	beforeEach(() => {
		executedCommands = [];
		shellExecutor = mock(async (cmd: string[]) => {
			executedCommands.push(cmd);
		});
	});

	describe("detectPackageManager", () => {
		let existsSyncSpy: ReturnType<typeof spyOn>;

		afterEach(() => {
			existsSyncSpy?.mockRestore();
		});

		it("detects bun from bun.lock", () => {
			existsSyncSpy = spyOn(fs, "existsSync").mockImplementation((p) => String(p).endsWith("bun.lock"));
			const installer = new ClientInstaller(shellExecutor);

			const pm = installer.detectPackageManager();

			expect(pm).toEqual({ name: "bun", installCommand: "add" });
		});

		it("detects bun from bun.lockb", () => {
			existsSyncSpy = spyOn(fs, "existsSync").mockImplementation((p) => String(p).endsWith("bun.lockb"));
			const installer = new ClientInstaller(shellExecutor);

			const pm = installer.detectPackageManager();

			expect(pm).toEqual({ name: "bun", installCommand: "add" });
		});

		it("detects yarn from yarn.lock", () => {
			existsSyncSpy = spyOn(fs, "existsSync").mockImplementation((p) => String(p).endsWith("yarn.lock"));
			const installer = new ClientInstaller(shellExecutor);

			const pm = installer.detectPackageManager();

			expect(pm).toEqual({ name: "yarn", installCommand: "add" });
		});

		it("detects pnpm from pnpm-lock.yaml", () => {
			existsSyncSpy = spyOn(fs, "existsSync").mockImplementation((p) => String(p).endsWith("pnpm-lock.yaml"));
			const installer = new ClientInstaller(shellExecutor);

			const pm = installer.detectPackageManager();

			expect(pm).toEqual({ name: "pnpm", installCommand: "add" });
		});

		it("detects npm from package-lock.json", () => {
			existsSyncSpy = spyOn(fs, "existsSync").mockImplementation((p) => String(p).endsWith("package-lock.json"));
			const installer = new ClientInstaller(shellExecutor);

			const pm = installer.detectPackageManager();

			expect(pm).toEqual({ name: "npm", installCommand: "install" });
		});

		it("falls back to npm when no lockfile is found", () => {
			existsSyncSpy = spyOn(fs, "existsSync").mockReturnValue(false);
			const installer = new ClientInstaller(shellExecutor);

			const pm = installer.detectPackageManager();

			expect(pm).toEqual({ name: "npm", installCommand: "install" });
		});
	});

	describe("install", () => {
		let existsSyncSpy: ReturnType<typeof spyOn>;

		beforeEach(() => {
			existsSyncSpy = spyOn(fs, "existsSync").mockImplementation((p) => String(p).endsWith("bun.lock"));
		});

		afterEach(() => {
			existsSyncSpy?.mockRestore();
		});

		it("runs the install command with the detected package manager", async () => {
			const installer = new ClientInstaller(shellExecutor);

			const result = await installer.install();

			expect(result).toEqual({ packageManager: "bun" });
			expect(executedCommands).toEqual([["bun", "add", "@outbox-reader/client"]]);
		});

		it("returns the detected package manager name", async () => {
			existsSyncSpy.mockImplementation((p) => String(p).endsWith("yarn.lock"));
			const installer = new ClientInstaller(shellExecutor);

			const result = await installer.install();

			expect(result).toEqual({ packageManager: "yarn" });
			expect(executedCommands).toEqual([["yarn", "add", "@outbox-reader/client"]]);
		});

		it("propagates errors from the shell executor", async () => {
			const failingExecutor: ShellExecutor = mock(async () => {
				throw new Error("command failed");
			});
			const installer = new ClientInstaller(failingExecutor);

			await expect(installer.install()).rejects.toThrow("command failed");
		});
	});
});
