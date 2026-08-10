#!/usr/bin/env node

import { runDatabaseMigrationCli } from "../migrate.js";

try {
  await runDatabaseMigrationCli();
} catch {
  console.error("Database migration failed. Check DATABASE_URL and the migration assets.");
  process.exitCode = 1;
}
