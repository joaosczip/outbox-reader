import type { PrismaMigrationOptions } from "../types/migration-adapter-config";
import type { MigrationAdapter } from "./migration-adapter";
import { PrismaSchemaGenerator } from "./prisma-schema-generator";

export class PrismaMigrationAdapter implements MigrationAdapter {
	async createMigration(options: PrismaMigrationOptions): Promise<void> {
		const generator = new PrismaSchemaGenerator({
			config: {
				schemaPath: options.schemaPath,
				modelName: options.modelName,
				tableName: options.tableName,
				migrationName: options.migrationName,
				generateMigration: true,
			},
			configPath: options.configPath,
		});
		await generator.generate();
	}
}
