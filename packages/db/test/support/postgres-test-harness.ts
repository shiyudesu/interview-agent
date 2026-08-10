import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";

import { createDatabaseClient, type DatabaseClient } from "../../src/client.js";
import { runDatabaseMigrations } from "../../src/migrate.js";
import {
  loadAndValidateMigrationMetadata,
  readAndVerifyMigrationChecksums,
} from "../../src/migration-integrity.js";

const migrationsRoot = fileURLToPath(new URL("../../drizzle", import.meta.url));
const journalPath = resolve(migrationsRoot, "meta/_journal.json");

export interface MigrationJournalEntry {
  readonly idx: number;
  readonly tag: string;
  readonly when: number;
}

interface MigrationJournal {
  readonly entries: readonly MigrationJournalEntry[];
}

export interface PostgresTestDatabase {
  readonly client: DatabaseClient;
  readonly databaseUrl: string;
  readonly name: string;
  readonly pool: Pool;
  close(): Promise<void>;
}

export interface CreateTestDatabaseOptions {
  readonly migrate?: boolean;
  readonly name?: string;
}

export class PostgresTestHarness {
  readonly adminDatabaseUrl: string;
  private databaseSequence = 0;
  private readonly databases = new Set<PostgresTestDatabase>();
  private stopPromise: Promise<void> | undefined;

  private constructor(private readonly container: StartedTestContainer) {
    const url = new URL("postgresql://interview:interview@localhost/postgres");
    url.hostname = container.getHost();
    url.port = String(container.getMappedPort(5432));
    this.adminDatabaseUrl = url.toString();
  }

  static async start(): Promise<PostgresTestHarness> {
    try {
      const container = await new GenericContainer("postgres:18.4-alpine")
        .withEnvironment({
          POSTGRES_DB: "postgres",
          POSTGRES_PASSWORD: "interview",
          POSTGRES_USER: "interview",
        })
        .withExposedPorts(5432)
        .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
        .withStartupTimeout(120_000)
        .start();
      return new PostgresTestHarness(container);
    } catch (error) {
      throw new Error(
        "Docker is required for PostgreSQL integration tests. Start Docker and rerun the test command.",
        { cause: error },
      );
    }
  }

  async createDatabase(options: CreateTestDatabaseOptions = {}): Promise<PostgresTestDatabase> {
    const name = options.name ?? `interview_test_${++this.databaseSequence}`;
    assertSafeDatabaseName(name);
    const adminPool = new Pool({ connectionString: this.adminDatabaseUrl, max: 1 });
    try {
      await adminPool.query(`drop database if exists "${name}" with (force)`);
      await adminPool.query(`create database "${name}"`);
    } finally {
      await adminPool.end();
    }

    const databaseUrl = databaseUrlFor(this.adminDatabaseUrl, name);
    if (options.migrate !== false) {
      await runDatabaseMigrations({ databaseUrl });
    }
    const client = createDatabaseClient({ databaseUrl, max: 12 });
    let closePromise: Promise<void> | undefined;
    const database: PostgresTestDatabase = {
      client,
      databaseUrl,
      name,
      pool: client.pool,
      close: () => {
        closePromise ??= client.close();
        return closePromise;
      },
    };
    this.databases.add(database);
    return database;
  }

  async dropDatabase(database: PostgresTestDatabase): Promise<void> {
    await database.close();
    this.databases.delete(database);
    const adminPool = new Pool({ connectionString: this.adminDatabaseUrl, max: 1 });
    try {
      await adminPool.query(`drop database if exists "${database.name}" with (force)`);
    } finally {
      await adminPool.end();
    }
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopResources();
    return this.stopPromise;
  }

  private async stopResources(): Promise<void> {
    const closeResults = await Promise.allSettled(
      Array.from(this.databases, (database) => database.close()),
    );
    await this.container.stop();
    const rejected = closeResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejected !== undefined) {
      throw rejected.reason;
    }
  }
}

export async function readMigrationJournal(): Promise<readonly MigrationJournalEntry[]> {
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as MigrationJournal;
  return journal.entries;
}

export async function migrationHashes(): Promise<readonly string[]> {
  const metadata = await loadAndValidateMigrationMetadata(migrationsRoot);
  const manifest = await readAndVerifyMigrationChecksums(migrationsRoot, metadata);
  return metadata.journal.entries.map((entry) => {
    const hash = manifest.migrations[entry.tag];
    if (hash === undefined) {
      throw new Error(`Missing pinned migration checksum for ${entry.tag}`);
    }
    return hash;
  });
}

function databaseUrlFor(adminDatabaseUrl: string, databaseName: string): string {
  const url = new URL(adminDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function assertSafeDatabaseName(databaseName: string): void {
  if (!/^[a-z][a-z0-9_]*$/.test(databaseName)) {
    throw new Error(`Unsafe test database name: ${databaseName}`);
  }
}
