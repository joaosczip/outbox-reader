import * as fs from 'fs';
import * as path from 'path';
import { PrismaSchemaGenerator } from '../src/services/prisma-schema-generator';

describe('PrismaSchemaGenerator', () => {
	const testDir = path.join(__dirname, 'temp');
	const testSchemaPath = path.join(testDir, 'schema.prisma');

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

	it('should create a new schema file with outbox model', async () => {
		const generator = new PrismaSchemaGenerator({
			config: {
				schemaPath: testSchemaPath,
				modelName: 'OutboxRecord',
				tableName: 'outbox',
				generateMigration: false,
			},
		});

		await generator.generateSchema();

		expect(fs.existsSync(testSchemaPath)).toBe(true);

		const content = fs.readFileSync(testSchemaPath, 'utf-8');
		expect(content).toContain('model OutboxRecord');
		expect(content).toContain('@@map("outbox")');
		expect(content).toContain('aggregateId');
		expect(content).toContain('eventType');
		expect(content).toContain('payload');
	});

	it('should append to existing schema file', async () => {
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
				modelName: 'OutboxRecord',
				tableName: 'outbox',
				generateMigration: false,
			},
		});

		await generator.generateSchema();

		const content = fs.readFileSync(testSchemaPath, 'utf-8');
		expect(content).toContain('model User'); // Original content preserved
		expect(content).toContain('model OutboxRecord'); // New model added
	});

	it('should not duplicate outbox model if it already exists', async () => {
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
				modelName: 'OutboxRecord',
				tableName: 'outbox',
				generateMigration: false,
			},
		});

		await generator.generateSchema();

		const content = fs.readFileSync(testSchemaPath, 'utf-8');
		const modelMatches = content.match(/model OutboxRecord/g);
		expect(modelMatches?.length).toBe(1); // Should only appear once
	});

	it('should include custom fields in the model', async () => {
		const generator = new PrismaSchemaGenerator({
			config: {
				schemaPath: testSchemaPath,
				modelName: 'OutboxRecord',
				tableName: 'outbox',
				generateMigration: false,
				customFields: {
					tenantId: 'String?',
					version: 'Int @default(1)',
				},
			},
		});

		await generator.generateSchema();

		const content = fs.readFileSync(testSchemaPath, 'utf-8');
		expect(content).toContain('tenantId        String?');
		expect(content).toContain('version        Int @default(1)');
	});
});
