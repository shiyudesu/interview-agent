import { spawn } from "node:child_process";
import { mkdir, rm, symlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = resolve(packageRoot, "../..");
const cliTarget = resolve(packageRoot, "dist/cli/migrate.js");
const cliLink = resolve(packageRoot, ".test-artifacts/interview-agent-db-migrate");

interface ProcessResult {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

function run(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  cwd = packageRoot,
): Promise<ProcessResult> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolveProcess({ exitCode, stderr, stdout });
    });
  });
}

describe.sequential("database migration CLI", () => {
  let container: StartedTestContainer;
  let databaseUrl: string;

  beforeAll(async () => {
    await mkdir(dirname(cliLink), { recursive: true });
    await rm(cliLink, { force: true });
    await symlink(cliTarget, cliLink);

    container = await new GenericContainer("postgres:18.4-alpine")
      .withEnvironment({
        POSTGRES_DB: "interview",
        POSTGRES_PASSWORD: "interview",
        POSTGRES_USER: "interview",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
      .withStartupTimeout(120_000)
      .start();
    databaseUrl = `postgres://interview:interview@${container.getHost()}:${container.getMappedPort(5432)}/interview`;
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
    await rm(dirname(cliLink), { force: true, recursive: true });
  });

  it("fails nonzero through a symlink when DATABASE_URL is missing", async () => {
    const result = await run(process.execPath, [cliLink], {
      ...process.env,
      DATABASE_URL: "",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Database migration failed.");
    expect(result.stdout).toBe("");
  });

  it("runs through the pnpm script and a deployed-style bin symlink", async () => {
    const environment = { ...process.env, DATABASE_URL: databaseUrl };
    const packageScript = await run(
      "pnpm",
      ["--filter", "@interview-agent/db", "db:migrate"],
      environment,
      repositoryRoot,
    );
    const symlinkedBin = await run(process.execPath, [cliLink], environment);

    expect(packageScript.exitCode, packageScript.stderr).toBe(0);
    expect(packageScript.stdout).toContain("Database migrations completed.");
    expect(symlinkedBin.exitCode, symlinkedBin.stderr).toBe(0);
    expect(symlinkedBin.stdout).toContain("Database migrations completed.");

    const pool = new Pool({ connectionString: databaseUrl });

    try {
      const tables = await pool.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
          order by table_name`,
      );
      const indexes = await pool.query<{ indexdef: string; indexname: string }>(
        `select indexdef, indexname
           from pg_indexes
          where schemaname = 'public' and tablename = 'account'
          order by indexname`,
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual([
        "account",
        "session",
        "user",
        "verification",
      ]);
      expect(indexes.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            indexdef: expect.stringMatching(
              /CREATE UNIQUE INDEX .* ON public\.account USING btree \(provider_id, account_id\)/,
            ),
            indexname: "account_providerId_accountId_idx",
          }),
        ]),
      );

      await pool.query(
        `insert into "user" (id, name, email)
         values ('user-1', 'First', 'first@example.com'),
                ('user-2', 'Second', 'second@example.com')`,
      );
      await pool.query(
        `insert into account (id, account_id, provider_id, user_id, updated_at)
         values ('account-1', 'external-identity', 'github', 'user-1', now())`,
      );

      await expect(
        pool.query(
          `insert into account (id, account_id, provider_id, user_id, updated_at)
           values ('account-2', 'external-identity', 'github', 'user-2', now())`,
        ),
      ).rejects.toMatchObject({
        code: "23505",
        constraint: "account_providerId_accountId_idx",
      });
    } finally {
      await pool.end();
    }
  }, 120_000);
});
