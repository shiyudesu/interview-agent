import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { createDatabaseClient } from "./client.js";
import { loadDatabaseEnvironment, requireDatabaseUrl } from "./config.js";

const defaultMigrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export interface MigrationOptions {
  readonly databaseUrl: string;
  readonly migrationsFolder?: string;
}

export async function runDatabaseMigrations({
  databaseUrl,
  migrationsFolder = defaultMigrationsFolder,
}: MigrationOptions): Promise<void> {
  const client = createDatabaseClient({ databaseUrl, max: 1 });

  try {
    await migrate(client.database, { migrationsFolder });
  } finally {
    await client.close();
  }
}

export async function runDatabaseMigrationCli(): Promise<void> {
  loadDatabaseEnvironment();
  await runDatabaseMigrations({ databaseUrl: requireDatabaseUrl() });
  console.info("Database migrations completed.");
}
