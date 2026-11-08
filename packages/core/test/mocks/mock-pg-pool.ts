import { mock } from "bun:test";
import type { Pool } from "pg";

export type QueryCall = { text: string; params: unknown[] | undefined };

type QueryResult = { rows: Record<string, unknown>[]; rowCount: number | null };

/**
 * Minimal pg.Pool stand-in that records every query (SQL text + params)
 * and answers with queued results (or an empty result by default).
 */
export class MockPgPool {
	public calls: QueryCall[] = [];
	private results: QueryResult[] = [];

	public query = mock(async (text: string, params?: unknown[]): Promise<QueryResult> => {
		this.calls.push({ text, params });
		return this.results.shift() ?? { rows: [], rowCount: 0 };
	});

	public release = mock(() => {});

	public connect = mock(async () => ({ query: this.query, release: this.release }));

	enqueueResult(result: Partial<QueryResult>): void {
		this.results.push({ rows: result.rows ?? [], rowCount: result.rowCount ?? result.rows?.length ?? 0 });
	}

	asPool(): Pool {
		return this as unknown as Pool;
	}

	lastCall(): QueryCall {
		const call = this.calls.at(-1);
		if (!call) throw new Error("No query was executed");
		return call;
	}
}

/** Collapses whitespace so SQL assertions are layout-independent. */
export const normalizeSql = (sql: string): string => sql.replace(/\s+/g, " ").trim();
