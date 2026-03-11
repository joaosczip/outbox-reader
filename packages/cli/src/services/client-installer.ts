import fs from "node:fs";
import path from "node:path";
import { $ } from "bun";

interface PackageManagerInfo {
	name: string;
	installCommand: string;
}

const LOCKFILE_MAP: Record<string, PackageManagerInfo> = {
	"bun.lock": { name: "bun", installCommand: "add" },
	"bun.lockb": { name: "bun", installCommand: "add" },
	"yarn.lock": { name: "yarn", installCommand: "add" },
	"pnpm-lock.yaml": { name: "pnpm", installCommand: "add" },
	"package-lock.json": { name: "npm", installCommand: "install" },
};

const DEFAULT_PACKAGE_MANAGER: PackageManagerInfo = {
	name: "npm",
	installCommand: "install",
};

const PACKAGE_NAME = "@outbox-reader/client";

export type ShellExecutor = (cmd: string[]) => Promise<void>;

const defaultShellExecutor: ShellExecutor = async (cmd: string[]) => {
	const [bin, ...args] = cmd;
	await $`${bin} ${args}`;
};

export interface ClientInstallerResult {
	packageManager: string;
}

export class ClientInstaller {
	constructor(private readonly shellExecutor: ShellExecutor = defaultShellExecutor) {}

	async install(): Promise<ClientInstallerResult> {
		const pm = this.detectPackageManager();
		const cmd = [pm.name, pm.installCommand, PACKAGE_NAME];

		console.log(`Detected package manager: ${pm.name}`);
		console.log(`Running: ${cmd.join(" ")}`);

		await this.shellExecutor(cmd);

		return { packageManager: pm.name };
	}

	detectPackageManager(): PackageManagerInfo {
		const cwd = process.cwd();
		for (const [lockfile, info] of Object.entries(LOCKFILE_MAP)) {
			if (fs.existsSync(path.join(cwd, lockfile))) {
				return info;
			}
		}
		return DEFAULT_PACKAGE_MANAGER;
	}
}
