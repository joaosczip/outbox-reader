import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// lib.ts is the programmatic entry point: importing it must not read required env vars,
// start telemetry or bind the health server. It must expose everything needed to
// assemble a runtime equivalent to app.ts.

const REQUIRED_ENV = ["DATABASE_URL", "REPLICATION_SLOT_NAME"] as const;

describe("lib (public API)", () => {
	const saved: Partial<Record<(typeof REQUIRED_ENV)[number], string>> = {};
	let lib: Record<string, unknown>;

	beforeAll(async () => {
		for (const key of REQUIRED_ENV) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
		lib = (await import("../src/lib")) as Record<string, unknown>;
	});

	afterAll(() => {
		for (const key of REQUIRED_ENV) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	});

	it("imports without DATABASE_URL / REPLICATION_SLOT_NAME set", () => {
		expect(lib).toBeDefined();
		expect(process.env.DATABASE_URL).toBeUndefined();
	});

	it.each(["OutboxRepository", "OutboxProcessor", "NATSPublisher", "RetryQueue", "Logger"])(
		"exports the %s class",
		(name) => {
			expect(typeof lib[name]).toBe("function");
			expect(Function.prototype.toString.call(lib[name])).toStartWith("class");
		},
	);

	it.each([
		"startReplication",
		"buildReplicationConnectionString",
		"createWalChangeHandler",
		"startHealthServer",
		"runOrderedByKey",
		"loadAppConfig",
		"loadCronConfig",
		"loadPublisherConfig",
		"createPublisher",
		"getColumnNames",
		"applyNamingToTableName",
	])("exports the %s function", (name) => {
		expect(typeof lib[name]).toBe("function");
	});

	it("exports the retry and attempt configuration values", () => {
		for (const name of ["dbWriteRetryConfig", "retryQueueConfig"]) {
			expect(lib[name]).toMatchObject({
				numOfAttempts: expect.any(Number),
				startingDelayInMs: expect.any(Number),
				maxDelayInMs: expect.any(Number),
			});
		}
		expect(lib.maxOutboxAttempts).toBeNumber();
		expect(lib.DEFAULT_CHECK_TIMEOUT_MS).toBeNumber();
	});

	it("exports the lazy config without evaluating required variables", () => {
		const config = lib.config as { slotName: string; tableName: string };

		expect(config.tableName).toBeString();
		expect(() => config.slotName).toThrow("Environment variable REPLICATION_SLOT_NAME is required");
	});

	it("loadCronConfig reports the missing DATABASE_URL only when called", () => {
		expect(() => (lib.loadCronConfig as () => unknown)()).toThrow("Environment variable DATABASE_URL is required");
	});

	it("does not export non-existent symbols advertised by older docs", () => {
		expect(lib).not.toHaveProperty("natsPublisherRetryConfig");
		expect(lib).not.toHaveProperty("natsConnectionConfig");
	});

	it("never imports telemetry or the app entry point (directly or transitively)", () => {
		const srcDir = resolve(import.meta.dir, "../src");
		const transpiler = new Bun.Transpiler({ loader: "ts" });
		const visited = new Set<string>();
		const resolveLocal = (from: string, spec: string): string | null => {
			if (!spec.startsWith(".")) return null;
			const base = resolve(dirname(from), spec);
			for (const candidate of [`${base}.ts`, join(base, "index.ts"), base]) {
				if (existsSync(candidate) && candidate.endsWith(".ts")) return candidate;
			}
			return null;
		};
		const walk = (file: string) => {
			if (visited.has(file)) return;
			visited.add(file);
			for (const { path } of transpiler.scanImports(readFileSync(file, "utf8"))) {
				const next = resolveLocal(file, path);
				if (next) walk(next);
			}
		};

		walk(join(srcDir, "lib.ts"));

		expect(visited.has(join(srcDir, "health.ts"))).toBe(true); // sanity: graph was walked
		expect(visited.has(join(srcDir, "telemetry.ts"))).toBe(false);
		expect(visited.has(join(srcDir, "app.ts"))).toBe(false);
	});

	it("is re-exported unchanged by the package index", async () => {
		const index = (await import("../src/index")) as Record<string, unknown>;

		expect(Object.keys(index).sort()).toEqual(Object.keys(lib).sort());
	});
});
