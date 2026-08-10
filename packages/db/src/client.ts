import type { Logger } from "drizzle-orm/logger";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import * as schema from "./schema/index.js";

export type Database = NodePgDatabase<typeof schema>;

export interface PostgresPoolOptions extends Omit<PoolConfig, "connectionString"> {
  readonly databaseUrl: string;
}

export interface DatabaseClientOptions extends PostgresPoolOptions {
  readonly logger?: Logger;
}

export interface DatabaseClient {
  readonly database: Database;
  readonly pool: Pool;
  close(): Promise<void>;
}

function validateDatabaseUrl(databaseUrl: string): string {
  const value = databaseUrl.trim();

  if (!value) {
    throw new Error("A PostgreSQL database URL is required.");
  }

  try {
    const parsed = new URL(value);

    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new Error("The PostgreSQL database URL is invalid.");
  }

  return value;
}

export function createPostgresPool({ databaseUrl, ...poolConfig }: PostgresPoolOptions): Pool {
  return new Pool({
    ...poolConfig,
    connectionString: validateDatabaseUrl(databaseUrl),
  });
}

export function createDatabaseClient({
  logger,
  ...options
}: DatabaseClientOptions): DatabaseClient {
  const pool = createPostgresPool(options);
  const database = drizzle(pool, logger === undefined ? { schema } : { schema, logger });
  let closePromise: Promise<void> | undefined;

  return {
    database,
    pool,
    close() {
      closePromise ??= pool.end();
      return closePromise;
    },
  };
}
