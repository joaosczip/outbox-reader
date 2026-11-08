/**
 * Health HTTP server.
 *
 * Routes (GET only; everything else → 404):
 * - `/live`   → always 200 `{ status: "ok" }` (process is up).
 * - `/ready`  → runs every readiness check concurrently, each bounded by `checkTimeoutMs`.
 *               A check that returns false, throws/rejects or times out is "fail".
 *               200 `{ status: "ok", checks: { name: "ok" } }` when all pass (or none registered),
 *               503 `{ status: "fail", checks: { ... } }` otherwise.
 * - `/health` → alias of `/ready` (kept for existing orchestrator configs).
 *
 * Checks can be passed at start (`readinessChecks`) and added/replaced/removed later via
 * `server.setReadinessCheck(name, fn)` / `server.removeReadinessCheck(name)` on the returned
 * server — useful when the publisher or replication is created after the server starts.
 */

import type { Server } from "bun";

export type ReadinessCheck = () => boolean | Promise<boolean>;

export type CheckResult = "ok" | "fail";

export interface HealthServerOptions {
	/** Port to bind. Defaults to the `PORT` env var, then 4599. Use 0 for a random free port. */
	port?: number;
	/** Initial readiness checks, keyed by name. The object is copied, not mutated. */
	readinessChecks?: Record<string, ReadinessCheck>;
	/** Per-check timeout in milliseconds. Defaults to 2000. */
	checkTimeoutMs?: number;
}

export type HealthServer = Server<undefined> & {
	/** Register or replace a readiness check by name. */
	setReadinessCheck(name: string, check: ReadinessCheck): void;
	/** Remove a readiness check by name (no-op if absent). */
	removeReadinessCheck(name: string): void;
};

export const DEFAULT_CHECK_TIMEOUT_MS = 2000;

async function runCheck(check: ReadinessCheck, timeoutMs: number): Promise<CheckResult> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<CheckResult>((resolve) => {
		timer = setTimeout(() => resolve("fail"), timeoutMs);
	});
	const evaluation = (async (): Promise<CheckResult> => ((await check()) === true ? "ok" : "fail"))().catch(
		(): CheckResult => "fail",
	);
	try {
		return await Promise.race([evaluation, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

export function startHealthServer(portOrOptions?: number | HealthServerOptions): HealthServer {
	const options: HealthServerOptions =
		typeof portOrOptions === "number" ? { port: portOrOptions } : (portOrOptions ?? {});
	const resolvedPort = options.port ?? Number(process.env.PORT ?? "4599");
	const timeoutMs = options.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
	const checks = new Map<string, ReadinessCheck>(Object.entries(options.readinessChecks ?? {}));

	const readiness = async (): Promise<Response> => {
		const entries = [...checks.entries()];
		const results = await Promise.all(entries.map(([, check]) => runCheck(check, timeoutMs)));
		const body: Record<string, CheckResult> = {};
		entries.forEach(([name], i) => {
			body[name] = results[i] as CheckResult;
		});
		const allOk = results.every((r) => r === "ok");
		return Response.json({ status: allOk ? "ok" : "fail", checks: body }, { status: allOk ? 200 : 503 });
	};

	const server = Bun.serve({
		port: resolvedPort,
		fetch(req) {
			if (req.method !== "GET") {
				return new Response(null, { status: 404 });
			}
			switch (new URL(req.url).pathname) {
				case "/live":
					return Response.json({ status: "ok" });
				case "/ready":
				case "/health":
					return readiness();
				default:
					return new Response(null, { status: 404 });
			}
		},
	});

	return Object.assign(server, {
		setReadinessCheck(name: string, check: ReadinessCheck) {
			checks.set(name, check);
		},
		removeReadinessCheck(name: string) {
			checks.delete(name);
		},
	});
}
