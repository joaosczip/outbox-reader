import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type HealthServer, startHealthServer } from "../src/health";

describe("Health endpoint", () => {
	let server: HealthServer;
	let baseUrl: string;

	afterEach(() => {
		server.stop(true);
	});

	describe("backward compatibility", () => {
		beforeEach(() => {
			server = startHealthServer(0); // port 0 = OS assigns a free port
			baseUrl = `http://localhost:${server.port}`;
		});

		it("accepts a numeric port and returns 200 { status: 'ok' } on GET /health with no checks", async () => {
			const res = await fetch(`${baseUrl}/health`);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toContain("application/json");
			expect(await res.json()).toEqual({ status: "ok", checks: {} });
		});

		it("returns 404 for unknown routes", async () => {
			const res = await fetch(`${baseUrl}/unknown`);
			expect(res.status).toBe(404);
		});

		it("returns 404 for non-GET methods", async () => {
			for (const path of ["/health", "/ready", "/live"]) {
				const res = await fetch(`${baseUrl}${path}`, { method: "POST" });
				expect(res.status).toBe(404);
			}
		});
	});

	describe("no-argument form", () => {
		const originalPort = process.env.PORT;

		beforeEach(() => {
			process.env.PORT = "0";
			server = startHealthServer();
			baseUrl = `http://localhost:${server.port}`;
		});

		afterEach(() => {
			if (originalPort === undefined) Reflect.deleteProperty(process.env, "PORT");
			else process.env.PORT = originalPort;
		});

		it("binds the PORT env var and serves /live", async () => {
			expect(server.port).toBeGreaterThan(0);
			const res = await fetch(`${baseUrl}/live`);
			expect(res.status).toBe(200);
		});
	});

	describe("readiness checks", () => {
		let checks: Record<string, () => boolean | Promise<boolean>>;

		beforeEach(() => {
			checks = {
				db: () => true,
				nats: async () => true,
			};
			server = startHealthServer({ port: 0, readinessChecks: checks, checkTimeoutMs: 50 });
			baseUrl = `http://localhost:${server.port}`;
		});

		it("returns 200 with every check marked ok when all pass", async () => {
			for (const path of ["/ready", "/health"]) {
				const res = await fetch(`${baseUrl}${path}`);
				expect(res.status).toBe(200);
				expect(await res.json()).toEqual({ status: "ok", checks: { db: "ok", nats: "ok" } });
			}
		});

		it("returns 503 and marks the check that returned false as fail", async () => {
			server.setReadinessCheck("nats", () => false);

			for (const path of ["/ready", "/health"]) {
				const res = await fetch(`${baseUrl}${path}`);
				expect(res.status).toBe(503);
				expect(await res.json()).toEqual({ status: "fail", checks: { db: "ok", nats: "fail" } });
			}
		});

		it("marks a throwing check (sync or async) as fail without crashing the server", async () => {
			server.setReadinessCheck("db", () => {
				throw new Error("boom");
			});
			server.setReadinessCheck("nats", async () => {
				throw new Error("async boom");
			});

			const res = await fetch(`${baseUrl}/ready`);
			expect(res.status).toBe(503);
			expect(await res.json()).toEqual({ status: "fail", checks: { db: "fail", nats: "fail" } });

			// Server still serves afterwards
			const live = await fetch(`${baseUrl}/live`);
			expect(live.status).toBe(200);
		});

		it("marks a check that exceeds checkTimeoutMs as fail and responds promptly", async () => {
			server.setReadinessCheck(
				"slow",
				() => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 1000)),
			);

			const started = Date.now();
			const res = await fetch(`${baseUrl}/ready`);
			const elapsed = Date.now() - started;

			expect(res.status).toBe(503);
			expect(await res.json()).toEqual({ status: "fail", checks: { db: "ok", nats: "ok", slow: "fail" } });
			expect(elapsed).toBeLessThan(500);
		});

		it("runs checks concurrently", async () => {
			const delayed = () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 30));
			server.setReadinessCheck("db", delayed);
			server.setReadinessCheck("nats", delayed);
			server.setReadinessCheck("other", delayed);

			const res = await fetch(`${baseUrl}/ready`);
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ status: "ok", checks: { db: "ok", nats: "ok", other: "ok" } });
		});

		it("does not mutate the caller's readinessChecks object", async () => {
			server.setReadinessCheck("extra", () => false);
			expect(Object.keys(checks)).toEqual(["db", "nats"]);
		});

		it("re-evaluates checks on every request", async () => {
			let healthy = false;
			server.setReadinessCheck("toggle", () => healthy);

			expect((await fetch(`${baseUrl}/ready`)).status).toBe(503);
			healthy = true;
			expect((await fetch(`${baseUrl}/ready`)).status).toBe(200);
		});

		it("removeReadinessCheck drops a check from the response", async () => {
			server.setReadinessCheck("nats", () => false);
			server.removeReadinessCheck("nats");

			const res = await fetch(`${baseUrl}/ready`);
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ status: "ok", checks: { db: "ok" } });
		});

		it("/live returns 200 even when readiness checks fail", async () => {
			server.setReadinessCheck("db", () => false);

			const res = await fetch(`${baseUrl}/live`);
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ status: "ok" });
		});
	});

	describe("checks registered after start", () => {
		beforeEach(() => {
			server = startHealthServer({ port: 0 });
			baseUrl = `http://localhost:${server.port}`;
		});

		it("returns 200 when no checks are registered", async () => {
			const res = await fetch(`${baseUrl}/ready`);
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ status: "ok", checks: {} });
		});

		it("includes a check registered via setReadinessCheck after the server started", async () => {
			server.setReadinessCheck("replication", () => false);

			const res = await fetch(`${baseUrl}/ready`);
			expect(res.status).toBe(503);
			expect(await res.json()).toEqual({ status: "fail", checks: { replication: "fail" } });
		});

		it("uses the default 2000ms timeout (a 100ms check still passes)", async () => {
			server.setReadinessCheck(
				"slowish",
				() => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 100)),
			);

			const res = await fetch(`${baseUrl}/ready`);
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ status: "ok", checks: { slowish: "ok" } });
		});
	});
});
