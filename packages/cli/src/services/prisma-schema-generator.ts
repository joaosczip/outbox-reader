import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { type ColumnNaming, applyNamingToTableName, getColumnNames } from "../utils/column-naming";
import type { OutboxSchemaGenerationOptions, SchemaGenerationConfig } from "../types/schema-config";

export class PrismaSchemaGenerator {
	private config: Required<SchemaGenerationConfig>;

	constructor(options: OutboxSchemaGenerationOptions = {}) {
		this.config = this.loadConfig(options);
	}

	private loadConfig(options: OutboxSchemaGenerationOptions): Required<SchemaGenerationConfig> {
		let configFromFile: Partial<SchemaGenerationConfig> = {};

		// Load config from file if provided
		if (options.configPath && existsSync(options.configPath)) {
			try {
				const configFile = readFileSync(options.configPath, "utf-8");
				configFromFile = JSON.parse(configFile);
			} catch (error) {
				console.warn(`Warning: Could not parse config file at ${options.configPath}:`, error);
			}
		}

		// Merge configs with defaults
		return {
			schemaPath: options.config?.schemaPath || configFromFile.schemaPath || "./prisma/schema.prisma",
			modelName: options.config?.modelName || configFromFile.modelName || "OutboxRecord",
			tableName: options.config?.tableName || configFromFile.tableName || "outbox",
			generateMigration: options.config?.generateMigration ?? configFromFile.generateMigration ?? true,
			migrationName: options.config?.migrationName || configFromFile.migrationName || "add_outbox_table",
			customFields: options.config?.customFields || configFromFile.customFields || {},
			columnNaming: options.config?.columnNaming || configFromFile.columnNaming || "snake_case",
		};
	}

	private getOutboxModelSchema(): string {
		const { modelName, tableName, customFields, columnNaming } = this.config;
		const naming: ColumnNaming = columnNaming ?? "snake_case";
		const cols = getColumnNames(naming);
		const dbTableName = applyNamingToTableName(tableName, naming);

		const mapAnnotation = (tsName: string, dbName: string) =>
			tsName !== dbName ? ` @map("${dbName}")` : "";

		const standardFields = [
			`id              String   @id @db.Uuid @default(dbgenerated("uuid_generate_v7()"))`,
			`aggregateId     String   @db.VarChar(50)${mapAnnotation("aggregateId", cols.aggregateId)}`,
			`aggregateType   String   @db.VarChar(50)${mapAnnotation("aggregateType", cols.aggregateType)}`,
			`eventType       String   @db.VarChar(50)${mapAnnotation("eventType", cols.eventType)}`,
			"payload         Json",
			`sequenceNumber  BigInt?${mapAnnotation("sequenceNumber", cols.sequenceNumber)}`,
			`createdAt       DateTime @default(now())${mapAnnotation("createdAt", cols.createdAt)}`,
			`processedAt     DateTime?${mapAnnotation("processedAt", cols.processedAt)}`,
			'status          String   @default("PENDING")',
			"attempts        Int      @default(0)",
		];

		// Add custom fields if any
		const customFieldsArray = Object.entries(customFields).map(
			([fieldName, fieldType]) => `${fieldName}        ${fieldType}`,
		);

		const allFields = [...standardFields, ...customFieldsArray];

		return `model ${modelName} {
  ${allFields.join("\n  ")}

  @@map("${dbTableName}")
  @@index([status])
  @@index([createdAt])
  @@index([sequenceNumber])
}`;
	}

	private getBaseSchema(): string {
		return `// This is your Prisma schema file,
// learn more about it in the docs: https://pris.ly/d/prisma-schema

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

`;
	}

	private hasOutboxModel(schemaContent: string): boolean {
		const modelRegex = new RegExp(`model\\s+${this.config.modelName}\\s*{`, "i");
		return modelRegex.test(schemaContent);
	}

	async generateSchema(): Promise<void> {
		const outboxModel = this.getOutboxModelSchema();

		if (await Bun.file(this.config.schemaPath).exists()) {
			// Append to existing schema
			const existingContent = await Bun.file(this.config.schemaPath).text();

			if (this.hasOutboxModel(existingContent)) {
				console.log(`✅ ${this.config.modelName} model already exists in ${this.config.schemaPath}`);
				return;
			}

			const updatedContent = `${existingContent}\n${outboxModel}\n`;
			await Bun.write(this.config.schemaPath, updatedContent);
			console.log(`✅ Added ${this.config.modelName} model to existing schema at ${this.config.schemaPath}`);
		} else {
			// Create new schema file
			const fullSchema = `${this.getBaseSchema() + outboxModel}\n`;
			await Bun.write(this.config.schemaPath, fullSchema);
			console.log(`✅ Created new schema file with ${this.config.modelName} model at ${this.config.schemaPath}`);
		}
	}

	async generateMigration(): Promise<void> {
		if (!this.config.generateMigration) {
			console.log("⏭️  Migration generation skipped (generateMigration = false)");
			return;
		}

		const schemaDir = path.dirname(this.config.schemaPath);
		const migrationsDir = path.join(schemaDir, "migrations");

		try {
			// Use Prisma CLI to generate migration
			const { execSync } = require("node:child_process");

			const command = `npx prisma migrate dev --name ${this.config.migrationName} --schema=${this.config.schemaPath}`;

			console.log(`🔄 Generating migration: ${command}`);
			execSync(command, { stdio: "inherit" });
			console.log(`✅ Migration '${this.config.migrationName}' generated successfully`);
		} catch (error) {
			console.error("❌ Failed to generate migration:", error);
			console.log("💡 You can manually run: npx prisma migrate dev --name add_outbox_table");
		}
	}

	async generate(): Promise<void> {
		console.log("🚀 Starting Prisma outbox schema generation...");
		console.log("📋 Configuration:", {
			schemaPath: this.config.schemaPath,
			modelName: this.config.modelName,
			tableName: this.config.tableName,
			generateMigration: this.config.generateMigration,
		});

		await this.generateSchema();

		if (this.config.generateMigration) {
			await this.generateMigration();
		}

		console.log("🎉 Schema generation completed!");
	}
}
