import * as fs from "node:fs";
import * as path from "node:path";
import { PrismaSchemaGenerator } from "../src/services/prisma-schema-generator";

describe("PrismaSchemaGenerator", () => {
	const testDir = path.join(__dirname, "temp");
	const testSchemaPath = path.join(testDir, "schema.prisma");

	beforeEach(() => {
		// Create test directory
		if (!fs.existsSync(testDir)) {
			fs.mkdirSync(testDir, { recursive: true });
		}
	});

	afterEach(() => {
		// Clean up test files
		if (fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("should create a new schema file with outbox model", async () => {
		const generator = new PrismaSchemaGenerator({
			config: {
				schemaPath: testSchemaPath,
				modelName: "OutboxRecord",
				tableName: "outbox",
				generateMigration: false,
			},
		});

		await generator.generateSchema();

		expect(fs.existsSync(testSchemaPath)).toBe(true);

		const content = fs.readFileSync(testSchemaPath, "utf-8");
		expect(content).toContain("model OutboxRecord");
		expect(content).toContain('@@map("outbox")');
		expect(content).toContain("aggregateId");
		expect(content).toContain("eventType");
		expect(content).toContain("payload");
		expect(content).toContain("@db.Uuid");
		expect(content).toContain('dbgenerated("uuid_generate_v7()")');
		expect(content).toContain("@db.VarChar(50)");
	});

	it("should append to existing schema file", async () => {
		// Create an existing schema file
		const existingSchema = `// Existing schema
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id    Int     @id @default(autoincrement())
  email String  @unique
  name  String?
}
`;

		fs.writeFileSync(testSchemaPath, existingSchema);

		const generator = new PrismaSchemaGenerator({
			config: {
				schemaPath: testSchemaPath,
				modelName: "OutboxRecord",
				tableName: "outbox",
				generateMigration: false,
			},
		});

		await generator.generateSchema();

		const content = fs.readFileSync(testSchemaPath, "utf-8");
		expect(content).toContain("model User"); // Original content preserved
		expect(content).toContain("model OutboxRecord"); // New model added
	});

	it("should not duplicate outbox model if it already exists", async () => {
		// Create schema with existing outbox model
		const existingSchema = `model OutboxRecord {
  id String @id
  // existing outbox model
}
`;

		fs.writeFileSync(testSchemaPath, existingSchema);

		const generator = new PrismaSchemaGenerator({
			config: {
				schemaPath: testSchemaPath,
				modelName: "OutboxRecord",
				tableName: "outbox",
				generateMigration: false,
			},
		});

		await generator.generateSchema();

		const content = fs.readFileSync(testSchemaPath, "utf-8");
		const modelMatches = content.match(/model OutboxRecord/g);
		expect(modelMatches?.length).toBe(1); // Should only appear once
	});

	it("should generate camelCase fields without @map annotations", async () => {
		const generator = new PrismaSchemaGenerator({
			config: {
				schemaPath: testSchemaPath,
				modelName: "OutboxRecord",
				tableName: "outbox",
				generateMigration: false,
				columnNaming: "camelCase",
			},
		});

		await generator.generateSchema();

		const content = fs.readFileSync(testSchemaPath, "utf-8");
		expect(content).toContain("aggregateId     String   @db.VarChar(50)");
		expect(content).not.toContain('@map("aggregate_id")');
		expect(content).not.toContain('@map("aggregateId")');
		expect(content).toContain('@@map("outbox")');
	});

	it("should generate PascalCase fields with @map annotations", async () => {
		const generator = new PrismaSchemaGenerator({
			config: {
				schemaPath: testSchemaPath,
				modelName: "OutboxRecord",
				tableName: "outbox",
				generateMigration: false,
				columnNaming: "PascalCase",
			},
		});

		await generator.generateSchema();

		const content = fs.readFileSync(testSchemaPath, "utf-8");
		expect(content).toContain('@map("AggregateId")');
		expect(content).toContain('@map("AggregateType")');
		expect(content).toContain('@map("EventType")');
		expect(content).toContain('@map("SequenceNumber")');
		expect(content).toContain('@map("CreatedAt")');
		expect(content).toContain('@map("ProcessedAt")');
		expect(content).toContain('@@map("Outbox")');
	});

	it("should apply PascalCase to multi-word table name", async () => {
		const generator = new PrismaSchemaGenerator({
			config: {
				schemaPath: testSchemaPath,
				modelName: "OutboxRecord",
				tableName: "my_outbox",
				generateMigration: false,
				columnNaming: "PascalCase",
			},
		});

		await generator.generateSchema();

		const content = fs.readFileSync(testSchemaPath, "utf-8");
		expect(content).toContain('@@map("MyOutbox")');
	});

	it("should include custom fields in the model", async () => {
		const generator = new PrismaSchemaGenerator({
			config: {
				schemaPath: testSchemaPath,
				modelName: "OutboxRecord",
				tableName: "outbox",
				generateMigration: false,
				customFields: {
					tenantId: "String?",
					version: "Int @default(1)",
				},
			},
		});

		await generator.generateSchema();

		const content = fs.readFileSync(testSchemaPath, "utf-8");
		expect(content).toContain("tenantId        String?");
		expect(content).toContain("version        Int @default(1)");
	});

	describe("indexes", () => {
		const cases = [
			{ naming: "snake_case", table: "outbox" },
			{ naming: "camelCase", table: "outbox" },
			{ naming: "PascalCase", table: "Outbox" },
		] as const;

		for (const { naming, table } of cases) {
			it(`declares only partial createdAt indexes for PENDING and FAILED (${naming})`, async () => {
				const generator = new PrismaSchemaGenerator({
					config: { schemaPath: testSchemaPath, generateMigration: false, columnNaming: naming },
				});

				await generator.generateSchema();

				const content = fs.readFileSync(testSchemaPath, "utf-8");
				expect(content).toContain(
					`@@index([createdAt], map: "idx_${table}_pending_created_at", where: { status: "PENDING" })`,
				);
				expect(content).toContain(
					`@@index([createdAt], map: "idx_${table}_failed_created_at", where: { status: "FAILED" })`,
				);
				// Regression: the status, sequenceNumber and unfiltered createdAt indexes must be gone.
				expect(content.match(/@@index\(/g)).toHaveLength(2);
				expect(content).not.toContain("@@index([status])");
				expect(content).not.toContain("@@index([sequenceNumber])");
				expect(content).not.toContain("@@index([createdAt])");
			});
		}

		it("derives partial index names from a custom table name", async () => {
			const generator = new PrismaSchemaGenerator({
				config: {
					schemaPath: testSchemaPath,
					tableName: "my_outbox",
					generateMigration: false,
					columnNaming: "PascalCase",
				},
			});

			await generator.generateSchema();

			const content = fs.readFileSync(testSchemaPath, "utf-8");
			expect(content).toContain('map: "idx_MyOutbox_pending_created_at"');
			expect(content).toContain('map: "idx_MyOutbox_failed_created_at"');
		});

		it("enables the partialIndexes preview feature in a new schema file", async () => {
			const generator = new PrismaSchemaGenerator({
				config: { schemaPath: testSchemaPath, generateMigration: false },
			});

			await generator.generateSchema();

			const content = fs.readFileSync(testSchemaPath, "utf-8");
			expect(content).toMatch(/generator client \{[^}]*previewFeatures = \["partialIndexes"\][^}]*\}/);
		});

		it("omits the datasource url in a new schema file, which Prisma >= 7 rejects", async () => {
			const generator = new PrismaSchemaGenerator({
				config: { schemaPath: testSchemaPath, generateMigration: false },
			});

			await generator.generateSchema();

			const content = fs.readFileSync(testSchemaPath, "utf-8");
			expect(content).toMatch(/datasource db \{\s*provider = "postgresql"\s*\}/);
			expect(content).not.toContain("url ");
		});

		it("adds the partialIndexes preview feature to an existing generator without previewFeatures", async () => {
			fs.writeFileSync(
				testSchemaPath,
				`generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
}
`,
			);
			const generator = new PrismaSchemaGenerator({
				config: { schemaPath: testSchemaPath, generateMigration: false },
			});

			await generator.generateSchema();

			const content = fs.readFileSync(testSchemaPath, "utf-8");
			expect(content).toContain(`generator client {
  provider = "prisma-client-js"
  previewFeatures = ["partialIndexes"]
}`);
			expect(content).toContain("model OutboxRecord");
		});

		it("appends partialIndexes to an existing previewFeatures list", async () => {
			fs.writeFileSync(
				testSchemaPath,
				`generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["relationJoins", "views"]
}
`,
			);
			const generator = new PrismaSchemaGenerator({
				config: { schemaPath: testSchemaPath, generateMigration: false },
			});

			await generator.generateSchema();

			const content = fs.readFileSync(testSchemaPath, "utf-8");
			expect(content).toContain('previewFeatures = ["relationJoins", "views", "partialIndexes"]');
		});

		it("does not duplicate an already enabled partialIndexes preview feature", async () => {
			const existing = `generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["partialIndexes"]
}
`;
			fs.writeFileSync(testSchemaPath, existing);
			const generator = new PrismaSchemaGenerator({
				config: { schemaPath: testSchemaPath, generateMigration: false },
			});

			await generator.generateSchema();

			const content = fs.readFileSync(testSchemaPath, "utf-8");
			expect(content.startsWith(existing)).toBe(true);
			expect(content.match(/partialIndexes/g)).toHaveLength(1);
		});
	});
});
