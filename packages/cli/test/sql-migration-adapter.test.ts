import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
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
			expect(sql).not.toContain("CREATE EXTENSION");
			expect(sql).not.toContain("uuid_generate_v7");
			expect(sql).toContain('CREATE TABLE IF NOT EXISTS "outbox" (');
			expect(sql).toContain('"id" UUID PRIMARY KEY,');
			expect(sql).toContain('"aggregate_id" VARCHAR(255) NOT NULL');
			expect(sql).toContain('"aggregate_type" VARCHAR(255) NOT NULL');
			expect(sql).toContain('"event_type" VARCHAR(255) NOT NULL');
			expect(sql).toContain('"payload" JSONB NOT NULL');
			expect(sql).toContain(`"status" TEXT NOT NULL DEFAULT 'PENDING'`);
			expect(sql).toContain('"attempts" INTEGER NOT NULL DEFAULT 0');
			expect(sql).toContain('"created_at" TIMESTAMP NOT NULL DEFAULT NOW()');
			expect(sql).toContain('"processed_at" TIMESTAMP');
			expect(sql).toContain('"sequence_number" BIGINT');
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
			expect(sql).toContain('CREATE TABLE IF NOT EXISTS "my_outbox"');
			expect(sql).toContain('"idx_my_outbox_pending_created_at" ON "my_outbox"("created_at")');
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
			// Regression: identifiers must be quoted, otherwise Postgres folds them to lowercase
			// and the columns no longer match the quoted names core (and Prisma) use.
			expect(sql).toContain('CREATE TABLE IF NOT EXISTS "outbox"');
			expect(sql).toContain('"aggregateId" VARCHAR(255) NOT NULL');
			expect(sql).toContain('"aggregateType" VARCHAR(255) NOT NULL');
			expect(sql).toContain('"eventType" VARCHAR(255) NOT NULL');
			expect(sql).toContain('"sequenceNumber" BIGINT');
			expect(sql).toContain('"createdAt" TIMESTAMP NOT NULL DEFAULT NOW()');
			expect(sql).toContain('"processedAt" TIMESTAMP');
			expect(sql).not.toMatch(/[^"]aggregateId[^"]/);
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
			expect(sql).toContain('CREATE TABLE IF NOT EXISTS "myOutbox"');
			expect(sql).toContain('"idx_myOutbox_pending_created_at" ON "myOutbox"("createdAt")');
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
			expect(sql).toContain('CREATE TABLE IF NOT EXISTS "Outbox"');
			expect(sql).toContain('"AggregateId" VARCHAR(255) NOT NULL');
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
			expect(sql).toContain('CREATE TABLE IF NOT EXISTS "MyOutbox"');
		});
	});

	describe("createMigration - indexes", () => {
		let written: string[];
		let stdoutSpy: ReturnType<typeof spyOn>;

		beforeEach(() => {
			written = [];
			stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
				written.push(String(chunk));
				return true;
			});
		});

		afterEach(() => {
			stdoutSpy.mockRestore();
		});

		const cases = [
			{ naming: "snake_case", table: "outbox", createdAt: "created_at", sequenceNumber: "sequence_number" },
			{ naming: "camelCase", table: "outbox", createdAt: "createdAt", sequenceNumber: "sequenceNumber" },
			{ naming: "PascalCase", table: "Outbox", createdAt: "CreatedAt", sequenceNumber: "SequenceNumber" },
		] as const;

		for (const { naming, table, createdAt, sequenceNumber } of cases) {
			it(`creates only partial created_at indexes for PENDING and FAILED (${naming})`, async () => {
				await adapter.createMigration({ target: "sql", columnNaming: naming });

				const sql = written.join("");
				expect(sql).toContain(
					`CREATE INDEX IF NOT EXISTS "idx_${table}_pending_created_at" ON "${table}"("${createdAt}") WHERE "status" = 'PENDING';`,
				);
				expect(sql).toContain(
					`CREATE INDEX IF NOT EXISTS "idx_${table}_failed_created_at" ON "${table}"("${createdAt}") WHERE "status" = 'FAILED';`,
				);
				// Regression: the low-selectivity status index, the unused sequence_number index and the
				// unfiltered created_at index amplify every status UPDATE and must not be generated.
				expect(sql.match(/CREATE INDEX/g)).toHaveLength(2);
				expect(sql).not.toContain(`ON "${table}"("status")`);
				expect(sql).not.toContain(`("${sequenceNumber}")`);
				expect(sql).not.toContain(`"idx_${table}_status"`);
				expect(sql).not.toContain(`"idx_${table}_sequence_number"`);
				expect(sql).not.toContain(`"idx_${table}_created_at"`);
			});
		}

		it("derives partial index names from a custom table name", async () => {
			await adapter.createMigration({ target: "sql", tableName: "my_outbox", columnNaming: "PascalCase" });

			const sql = written.join("");
			expect(sql).toContain(
				`CREATE INDEX IF NOT EXISTS "idx_MyOutbox_pending_created_at" ON "MyOutbox"("CreatedAt") WHERE "status" = 'PENDING';`,
			);
			expect(sql).toContain(
				`CREATE INDEX IF NOT EXISTS "idx_MyOutbox_failed_created_at" ON "MyOutbox"("CreatedAt") WHERE "status" = 'FAILED';`,
			);
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
			expect(content).toContain('CREATE TABLE IF NOT EXISTS "outbox"');

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
