import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { PrismaMigrationAdapter } from "../src/services/prisma-migration-adapter";
import { PrismaSchemaGenerator } from "../src/services/prisma-schema-generator";

describe("PrismaMigrationAdapter", () => {
  let adapter: PrismaMigrationAdapter;
  let generateSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    adapter = new PrismaMigrationAdapter();
    generateSpy = spyOn(PrismaSchemaGenerator.prototype, "generate").mockImplementation(async () => {});
  });

  afterEach(() => {
    generateSpy.mockRestore();
  });

  it("delegates to PrismaSchemaGenerator.generate()", async () => {
    await adapter.createMigration({ target: "prisma" });

    expect(generateSpy).toHaveBeenCalledTimes(1);
  });

  it("passes schemaPath, modelName, tableName, migrationName, and configPath to the generator", async () => {
    const constructorSpy = spyOn(PrismaSchemaGenerator.prototype as any, "loadConfig").mockReturnValue({
      schemaPath: "./custom/schema.prisma",
      modelName: "MyOutbox",
      tableName: "my_outbox",
      generateMigration: true,
      migrationName: "custom_migration",
      customFields: {},
    });

    await adapter.createMigration({
      target: "prisma",
      schemaPath: "./custom/schema.prisma",
      modelName: "MyOutbox",
      tableName: "my_outbox",
      migrationName: "custom_migration",
      configPath: "./outbox.config.json",
    });

    expect(generateSpy).toHaveBeenCalledTimes(1);
    constructorSpy.mockRestore();
  });

  it("propagates errors thrown by PrismaSchemaGenerator", async () => {
    generateSpy.mockImplementation(async () => {
      throw new Error("prisma generate failed");
    });

    await expect(adapter.createMigration({ target: "prisma" })).rejects.toThrow("prisma generate failed");
  });
});
