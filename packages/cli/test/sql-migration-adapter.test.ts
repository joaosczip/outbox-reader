import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import fs from "node:fs";
import { SqlMigrationAdapter } from "../src/services/sql-migration-adapter";

describe("SqlMigrationAdapter", () => {
	let adapter: SqlMigrationAdapter;

	beforeEach(() => {
		adapter = new SqlMigrationAdapter();
	});

	describe("createMigration - stdout output", () => {
		it("writes the SQL to stdout when no output path is given", async () => {
			const written: string[] = [];
			const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
				written.push(String(chunk));
				return true;
			});

			await adapter.createMigration({ target: "sql" });

			stdoutSpy.mockRestore();

			const sql = written.join("");
			expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS "pg_uuidv7"');
			expect(sql).toContain("CREATE TABLE IF NOT EXISTS outbox");
			expect(sql).toContain("id              UUID PRIMARY KEY DEFAULT uuid_generate_v7()");
			expect(sql).toContain("aggregate_id    VARCHAR(50) NOT NULL");
			expect(sql).toContain("aggregate_type  VARCHAR(50) NOT NULL");
			expect(sql).toContain("event_type      VARCHAR(50) NOT NULL");
			expect(sql).toContain("payload         JSONB NOT NULL");
			expect(sql).toContain("status          TEXT NOT NULL DEFAULT 'PENDING'");
			expect(sql).toContain("attempts        INTEGER NOT NULL DEFAULT 0");
			expect(sql).toContain("created_at      TIMESTAMP NOT NULL DEFAULT NOW()");
			expect(sql).toContain("processed_at    TIMESTAMP");
			expect(sql).toContain("sequence_number BIGINT");
			expect(sql).toContain("CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status)");
			expect(sql).toContain("CREATE INDEX IF NOT EXISTS idx_outbox_created_at ON outbox(created_at)");
			expect(sql).toContain("CREATE INDEX IF NOT EXISTS idx_outbox_sequence_number ON outbox(sequence_number)");
		});

		it("uses a custom table name in the SQL output", async () => {
			const written: string[] = [];
			const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
				written.push(String(chunk));
				return true;
			});

			await adapter.createMigration({ target: "sql", tableName: "my_outbox" });

			stdoutSpy.mockRestore();

			const sql = written.join("");
			expect(sql).toContain("CREATE TABLE IF NOT EXISTS my_outbox");
			expect(sql).toContain("idx_my_outbox_status ON my_outbox(status)");
		});
	});

	describe("createMigration - camelCase naming", () => {
		it("uses camelCase column names in the SQL output", async () => {
			const written: string[] = [];
			const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
				written.push(String(chunk));
				return true;
			});

			await adapter.createMigration({ target: "sql", columnNaming: "camelCase" });

			stdoutSpy.mockRestore();

			const sql = written.join("");
			expect(sql).toContain("CREATE TABLE IF NOT EXISTS outbox");
			expect(sql).toContain("aggregateId");
			expect(sql).toContain("aggregateType");
			expect(sql).toContain("eventType");
			expect(sql).toContain("sequenceNumber");
			expect(sql).toContain("createdAt");
			expect(sql).toContain("processedAt");
			expect(sql).not.toContain("aggregate_id");
			expect(sql).not.toContain("aggregate_type");
			expect(sql).not.toContain("event_type");
		});

		it("uses camelCase table name when --table-name is provided", async () => {
			const written: string[] = [];
			const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
				written.push(String(chunk));
				return true;
			});

			await adapter.createMigration({ target: "sql", tableName: "my_outbox", columnNaming: "camelCase" });

			stdoutSpy.mockRestore();

			const sql = written.join("");
			expect(sql).toContain("CREATE TABLE IF NOT EXISTS myOutbox");
		});
	});

	describe("createMigration - PascalCase naming", () => {
		it("uses PascalCase column names in the SQL output", async () => {
			const written: string[] = [];
			const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
				written.push(String(chunk));
				return true;
			});

			await adapter.createMigration({ target: "sql", columnNaming: "PascalCase" });

			stdoutSpy.mockRestore();

			const sql = written.join("");
			expect(sql).toContain("CREATE TABLE IF NOT EXISTS Outbox");
			expect(sql).toContain("AggregateId");
			expect(sql).toContain("AggregateType");
			expect(sql).toContain("EventType");
			expect(sql).toContain("SequenceNumber");
			expect(sql).toContain("CreatedAt");
			expect(sql).toContain("ProcessedAt");
			expect(sql).not.toContain("aggregate_id");
		});

		it("uses PascalCase table name when --table-name is provided", async () => {
			const written: string[] = [];
			const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
				written.push(String(chunk));
				return true;
			});

			await adapter.createMigration({ target: "sql", tableName: "my_outbox", columnNaming: "PascalCase" });

			stdoutSpy.mockRestore();

			const sql = written.join("");
			expect(sql).toContain("CREATE TABLE IF NOT EXISTS MyOutbox");
		});
	});

	describe("createMigration - file output", () => {
		let writeFileSyncSpy: ReturnType<typeof spyOn>;

		beforeEach(() => {
			writeFileSyncSpy = spyOn(fs, "writeFileSync").mockImplementation(() => {});
		});

		it("writes the SQL to the specified output file", async () => {
			const consoleSpy = spyOn(console, "log").mockImplementation(() => {});

			await adapter.createMigration({ target: "sql", output: "./migrations/create_outbox.sql" });

			expect(writeFileSyncSpy).toHaveBeenCalledTimes(1);
			const [filePath, content] = writeFileSyncSpy.mock.calls[0] as [string, string];
			expect(filePath).toBe("./migrations/create_outbox.sql");
			expect(content).toContain("CREATE TABLE IF NOT EXISTS outbox");

			consoleSpy.mockRestore();
			writeFileSyncSpy.mockRestore();
		});

		it("logs the output file path when writing to file", async () => {
			const logMessages: string[] = [];
			const consoleSpy = spyOn(console, "log").mockImplementation((msg: string) => {
				logMessages.push(msg);
			});

			await adapter.createMigration({ target: "sql", output: "./out.sql" });

			expect(logMessages).toContain("Created SQL migration at ./out.sql");

			consoleSpy.mockRestore();
			writeFileSyncSpy.mockRestore();
		});
	});
});
