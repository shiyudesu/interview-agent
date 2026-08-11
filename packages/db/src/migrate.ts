import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { createDatabaseClient } from "./client.js";
import { loadDatabaseEnvironment, requireDatabaseUrl } from "./config.js";

const defaultMigrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export interface MigrationOptions {
  readonly databaseUrl: string;
  readonly migrationsFolder?: string;
}

interface MigrationRepairQueryable {
  query(queryText: string): Promise<unknown>;
}

export async function runPreMigrationRepairs(queryable: MigrationRepairQueryable): Promise<void> {
  await queryable.query(`
    do $$
    begin
      if to_regclass('public.deletion_requests') is not null
         and exists (
           select 1
             from information_schema.columns
            where table_schema = 'public'
              and table_name = 'deletion_requests'
              and column_name = 'completed_at'
         )
         and not exists (
           select 1
             from information_schema.columns
            where table_schema = 'public'
              and table_name = 'deletion_requests'
              and column_name = 'attempt_count'
         )
      then
        update deletion_requests
           set completed_at = null
         where status in ('processing', 'failed')
           and completed_at is not null;
      end if;
    end
    $$;
  `);
}

export async function runDatabaseMigrations({
  databaseUrl,
  migrationsFolder = defaultMigrationsFolder,
}: MigrationOptions): Promise<void> {
  const client = createDatabaseClient({ databaseUrl, max: 1 });

  try {
    await runPreMigrationRepairs(client.pool);
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
