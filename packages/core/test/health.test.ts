import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { startHealthServer } from "../src/health";

describe("Health endpoint", () => {
	let server: ReturnType<typeof startHealthServer>;
	let port: number;

	beforeEach(() => {
		server = startHealthServer(0); // port 0 = OS assigns a free port
		port = server.port;
	});

	afterEach(() => {
		server.stop(true);
	});

	it("returns 200 with { status: 'ok' } on GET /health", async () => {
		const res = await fetch(`http://localhost:${port}/health`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ status: "ok" });
	});

	it("returns application/json content-type on GET /health", async () => {
		const res = await fetch(`http://localhost:${port}/health`);
		expect(res.headers.get("content-type")).toContain("application/json");
	});

	it("returns 404 for unknown routes", async () => {
		const res = await fetch(`http://localhost:${port}/unknown`);
		expect(res.status).toBe(404);
	});

	it("returns 404 for POST /health", async () => {
		const res = await fetch(`http://localhost:${port}/health`, { method: "POST" });
		expect(res.status).toBe(404);
	});
});
