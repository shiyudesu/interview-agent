import { defineConfig } from "drizzle-kit";

import { loadDatabaseEnvironment, requireDatabaseUrl } from "./src/config.js";

loadDatabaseEnvironment();

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url: requireDatabaseUrl(),
  },
  strict: true,
  verbose: true,
});
