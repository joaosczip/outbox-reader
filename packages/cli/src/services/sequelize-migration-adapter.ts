import path from "node:path";
import type { SequelizeMigrationOptions } from "../types/migration-adapter-config";
import { type ColumnNaming, applyNamingToTableName, getColumnNames } from "../utils/column-naming";
import type { MigrationAdapter } from "./migration-adapter";

export type FsWriter = (filePath: string, content: string) => Promise<void>;
export type RequireFn = (id: string) => unknown;
export type Clock = () => Date;

const defaultFsWriter: FsWriter = async (filePath, content) => {
	await Bun.write(filePath, content);
};

const defaultRequireFn: RequireFn = (id) => require(id);

const defaultClock: Clock = () => new Date();

export class SequelizeMigrationAdapter implements MigrationAdapter {
	constructor(
		private readonly fsWriter: FsWriter = defaultFsWriter,
		private readonly requireFn: RequireFn = defaultRequireFn,
		private readonly clock: Clock = defaultClock,
	) {}

	async createMigration(options: SequelizeMigrationOptions): Promise<void> {
		const migrationsPath = options.migrationsPath ?? this.discoverMigrationsPath(options.configPath);
		const migrationName = options.migrationName ?? "create-outbox-table";
		const naming: ColumnNaming = options.columnNaming ?? "snake_case";
		const rawTableName = options.tableName ?? "outbox";
		const tableName = applyNamingToTableName(rawTableName, naming);

		const timestamp = this.formatTimestamp(this.clock());
		const filename = `${timestamp}-${migrationName}.js`;
		const filePath = path.join(migrationsPath, filename);

		const cols = getColumnNames(naming);
		const content = this.renderMigration(tableName, cols);
		await this.fsWriter(filePath, content);

		console.log(`Created Sequelize migration at ${filePath}`);
	}

	private discoverMigrationsPath(configPath?: string): string {
		const sequelizercPath = configPath ?? path.join(process.cwd(), ".sequelizerc");

		try {
			const config = this.requireFn(sequelizercPath) as Record<string, unknown>;
			const migrationsPath = config["migrations-path"];
			if (typeof migrationsPath === "string") {
				return migrationsPath;
			}
		} catch {
			// fall through to default
		}

		return path.join(process.cwd(), "migrations");
	}

	private formatTimestamp(date: Date): string {
		const pad = (n: number, len = 2) => String(n).padStart(len, "0");
		return (
			String(date.getFullYear()) +
			pad(date.getMonth() + 1) +
			pad(date.getDate()) +
			pad(date.getHours()) +
			pad(date.getMinutes()) +
			pad(date.getSeconds())
		);
	}

	private renderMigration(tableName: string, cols: ReturnType<typeof getColumnNames>): string {
		return `"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query('CREATE EXTENSION IF NOT EXISTS "pg_uuidv7"');

    await queryInterface.createTable("${tableName}", {
      ${cols.id}: {
        type: Sequelize.UUID,
        primaryKey: true,
        allowNull: false,
        defaultValue: Sequelize.literal("uuid_generate_v7()"),
      },
      ${cols.aggregateId}: {
        type: Sequelize.STRING(50),
        allowNull: false,
      },
      ${cols.aggregateType}: {
        type: Sequelize.STRING(50),
        allowNull: false,
      },
      ${cols.eventType}: {
        type: Sequelize.STRING(50),
        allowNull: false,
      },
      ${cols.payload}: {
        type: Sequelize.JSONB,
        allowNull: false,
      },
      ${cols.status}: {
        type: Sequelize.TEXT,
        allowNull: false,
        defaultValue: "PENDING",
      },
      ${cols.attempts}: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      ${cols.createdAt}: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn("NOW"),
      },
      ${cols.processedAt}: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      ${cols.sequenceNumber}: {
        type: Sequelize.BIGINT,
        allowNull: true,
      },
    });

    await queryInterface.addIndex("${tableName}", ["${cols.status}"]);
    await queryInterface.addIndex("${tableName}", ["${cols.createdAt}"]);
    await queryInterface.addIndex("${tableName}", ["${cols.sequenceNumber}"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("${tableName}");
  },
};
`;
	}
}
