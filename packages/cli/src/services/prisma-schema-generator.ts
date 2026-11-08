import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import type { OutboxSchemaGenerationOptions, SchemaGenerationConfig } from "../types/schema-config";
import { type ColumnNaming, applyNamingToTableName, getColumnNames } from "../utils/column-naming";

/**
 * Prisma preview feature (Prisma ORM >= 7.4) required for `@@index(..., where: ...)`,
 * which the outbox model uses for its partial indexes.
 */
const PARTIAL_INDEXES_FEATURE = "partialIndexes";

/**
 * Enables the `partialIndexes` preview feature in the first `generator` block of a schema.
 * Returns the schema unchanged when the feature is already enabled or no generator exists.
 */
export function enablePartialIndexesPreviewFeature(schemaContent: string): string {
	const generatorMatch = /generator\s+\w+\s*\{[^}]*\}/.exec(schemaContent);
	if (!generatorMatch) {
		return schemaContent;
	}

	const block = generatorMatch[0];
	if (block.includes(`"${PARTIAL_INDEXES_FEATURE}"`)) {
		return schemaContent;
	}

	const previewFeaturesRegex = /(previewFeatures\s*=\s*\[)([^\]]*)\]/;
	const updatedBlock = previewFeaturesRegex.test(block)
		? block.replace(previewFeaturesRegex, (_match, prefix: string, features: string) => {
				const existing = features.trim();
				const list = existing ? `${existing}, "${PARTIAL_INDEXES_FEATURE}"` : `"${PARTIAL_INDEXES_FEATURE}"`;
				return `${prefix}${list}]`;
			})
		: block.replace(/\n?\s*\}$/, `\n  previewFeatures = ["${PARTIAL_INDEXES_FEATURE}"]\n}`);

	return (
		schemaContent.slice(0, generatorMatch.index) +
		updatedBlock +
		schemaContent.slice(generatorMatch.index + block.length)
	);
}

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

		const mapAnnotation = (tsName: string, dbName: string) => (tsName !== dbName ? ` @map("${dbName}")` : "");

		const standardFields = [
			`id              String   @id @db.Uuid @default(dbgenerated("uuid_generate_v7()"))`,
			`aggregateId     String   @db.VarChar(50)${mapAnnotation("aggregateId", cols.aggregateId)}`,
			`aggregateType   String   @db.VarChar(50)${mapAnnotation("aggregateType", cols.aggregateType)}`,
			`eventType       String   @db.VarChar(50)${mapAnnotation("eventType", cols.eventType)}`,
			"payload         Json",
			`sequenceNumber  BigInt?${mapAnnotation("sequenceNumber", cols.sequenceNumber)}`,
			`createdAt       DateTime @default(now())${mapAnnotation("createdAt", cols.createdAt)}`,
			`processedAt     DateTime?${mapAnnotation("processedAt", cols.processedAt)}`,
			`requeuedAt      DateTime?${mapAnnotation("requeuedAt", cols.requeuedAt)}`,
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
  @@index([createdAt], map: "idx_${dbTableName}_pending_created_at", where: { status: "PENDING" })
  @@index([createdAt], map: "idx_${dbTableName}_failed_created_at", where: { status: "FAILED" })
  @@index([aggregateId, createdAt, id], map: "idx_${dbTableName}_pending_aggregate_order", where: { status: "PENDING" })
  @@index([aggregateId, createdAt, id], map: "idx_${dbTableName}_failed_aggregate_order", where: { status: "FAILED" })
}`;
	}

	private getBaseSchema(): string {
		return `// This is your Prisma schema file,
// learn more about it in the docs: https://pris.ly/d/prisma-schema
// Requires Prisma ORM >= 7.4 ("partialIndexes" preview feature). The connection URL is
// configured in prisma.config.ts: https://pris.ly/d/config-datasource

generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["${PARTIAL_INDEXES_FEATURE}"]
}

datasource db {
  provider = "postgresql"
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

			const withPreviewFeature = enablePartialIndexesPreviewFeature(existingContent);
			if (!withPreviewFeature.includes(`"${PARTIAL_INDEXES_FEATURE}"`)) {
				console.warn(
					`⚠️  No generator block found in ${this.config.schemaPath}: enable the "${PARTIAL_INDEXES_FEATURE}" preview feature (Prisma >= 7.4) for the outbox partial indexes`,
				);
			}
			const updatedContent = `${withPreviewFeature}\n${outboxModel}\n`;
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
