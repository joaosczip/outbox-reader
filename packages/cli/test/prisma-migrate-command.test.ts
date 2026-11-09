import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PrismaSchemaGenerator } from "../src/services/prisma-schema-generator";

type Call = { command: string; args: string[] };

describe("PrismaSchemaGenerator.generateMigration", () => {
	let dir: string;
	let schemaPath: string;
	let calls: Call[];
	let status: number | null;
	let error: Error | undefined;

	const build = (migrationName = "add_outbox_table") =>
		new PrismaSchemaGenerator({
			config: { schemaPath, migrationName, generateMigration: true },
			runCommand: (command, args) => {
				calls.push({ command, args });
				return { status, error };
			},
		});

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "outy-prisma-"));
		schemaPath = path.join(dir, "my schema.prisma");
		calls = [];
		status = 0;
		error = undefined;
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("runs prisma migrate dev with literal arguments, without a shell", async () => {
		await build("add $HOME `whoami`").generateMigration();

		expect(calls).toEqual([
			{
				command: "npx",
				args: ["prisma", "migrate", "dev", "--name", "add $HOME `whoami`", `--schema=${schemaPath}`],
			},
		]);
	});

	it("rejects with the manual command when prisma exits with a non-zero status", async () => {
		status = 1;

		await expect(build("add_outbox_table").generateMigration()).rejects.toThrow(
			`prisma migrate dev exited with code 1. Run it manually: npx prisma migrate dev --name add_outbox_table --schema=${schemaPath}`,
		);
	});

	it("rejects when npx cannot be started", async () => {
		status = null;
		error = Object.assign(new Error("spawnSync npx ENOENT"), { code: "ENOENT" });

		await expect(build().generateMigration()).rejects.toThrow("Could not run npx prisma migrate dev");
	});
});
