import type { MigrationAdapterOptions, MigrationTarget } from "../types/migration-adapter-config";
import { PrismaMigrationAdapter } from "./prisma-migration-adapter";
import { SequelizeMigrationAdapter } from "./sequelize-migration-adapter";
import { SqlMigrationAdapter } from "./sql-migration-adapter";

export interface MigrationAdapter {
	createMigration(options: MigrationAdapterOptions): Promise<void>;
}

export function createMigrationAdapter(target: MigrationTarget | undefined): MigrationAdapter {
	switch (target) {
		case "prisma":
			return new PrismaMigrationAdapter();
		case "sequelize":
			return new SequelizeMigrationAdapter();
		case "sql":
		case undefined:
			return new SqlMigrationAdapter();
		default:
			throw new Error(`Unknown migration target: ${target}`);
	}
}
