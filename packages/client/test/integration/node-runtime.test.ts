import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Compiles the package exactly like `bun run build` (into a temp dir) and loads the
 * published entry points with plain Node.js, where the `Bun` global does not exist.
 */
const nodeBin = Bun.which("node");
const packageDir = resolve(__dirname, "../..");
const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));

type ExportTarget = { types: string; default: string };
const exportsMap = pkg.exports as Record<string, ExportTarget>;

describe.skipIf(!nodeBin)("published build on Node.js", () => {
	let outDir: string;

	/** Maps a `./dist/...` path from package.json into the temp build dir. */
	const built = (distPath: string): string => join(outDir, distPath.replace(/^\.?\/?dist\//, ""));

	const runNode = (args: string[]) => {
		const proc = Bun.spawnSync([nodeBin as string, ...args], { cwd: outDir, stderr: "pipe", stdout: "pipe" });
		return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
	};

	beforeAll(() => {
		outDir = mkdtempSync(join(tmpdir(), "outy-client-build-"));
		const tsc = Bun.spawnSync(
			["bunx", "tsc", "-p", join(packageDir, "tsconfig.json"), "--outDir", outDir, "--incremental", "false"],
			{ cwd: packageDir, stderr: "pipe", stdout: "pipe" },
		);
		if (tsc.exitCode !== 0) {
			throw new Error(`tsc failed:\n${tsc.stdout.toString()}${tsc.stderr.toString()}`);
		}
	}, 60_000);

	afterAll(() => {
		if (outDir) rmSync(outDir, { recursive: true, force: true });
	});

	it("emits every entry point declared in package.json", async () => {
		const targets = [pkg.main, pkg.types, ...Object.values(exportsMap).flatMap((t) => [t.default, t.types])];

		for (const target of targets) {
			expect(await Bun.file(built(target)).exists()).toBe(true);
		}
	});

	it("creates an event through require() of the root and subpath entry points", () => {
		const script = `
			const { OutboxClient } = require(${JSON.stringify(built(exportsMap["."].default))});
			const { PrismaAdapter } = require(${JSON.stringify(built(exportsMap["./prisma"].default))});
			const { SequelizeAdapter } = require(${JSON.stringify(built(exportsMap["./sequelize"].default))});
			(async () => {
				const calls = [];
				const tx = { $executeRawUnsafe: async (...args) => { calls.push(args); return 1; } };
				const id = await new OutboxClient(new PrismaAdapter()).create(
					{ aggregateId: "a", aggregateType: "A", eventType: "a.created", payload: {} }, tx);
				const seq = { query: async (...args) => { calls.push(args); return [[], 1]; } };
				const id2 = await new OutboxClient(new SequelizeAdapter(seq)).create(
					{ aggregateId: "a", aggregateType: "A", eventType: "a.created", payload: {} }, {});
				console.log(JSON.stringify({ id, id2, calls: calls.length, isBun: typeof Bun !== "undefined" }));
			})().catch((e) => { console.error(e); process.exit(1); });
		`;

		const result = runNode(["-e", script]);

		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
		const out = JSON.parse(result.stdout);
		expect(out.isBun).toBe(false);
		expect(out.calls).toBe(2);
		expect(out.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(out.id2).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	});

	it("can be imported from an ES module", () => {
		const script = `
			const mod = await import(${JSON.stringify(built(exportsMap["."].default))});
			console.log(typeof mod.OutboxClient, typeof mod.PrismaAdapter);
		`;

		const result = runNode(["--input-type=module", "-e", script]);

		expect(result.stderr).toBe("");
		expect(result.stdout.trim()).toBe("function function");
	});
});
