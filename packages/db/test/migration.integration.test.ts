import { spawn } from "node:child_process";
import { mkdir, readFile, rm, symlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = resolve(packageRoot, "../..");
const migrationsRoot = resolve(packageRoot, "drizzle");
const cliTarget = resolve(packageRoot, "dist/cli/migrate.js");
const cliLink = resolve(packageRoot, ".test-artifacts/interview-agent-db-migrate");

interface ProcessResult {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

const blueprintPositions = [1, 2, 3, 4, 5] as const;
const initialMigrationNames = ["0000_initial_auth.sql", "0001_interview_persistence.sql"] as const;

async function seedConstraintQuestions(client: PoolClient): Promise<void> {
  for (const position of blueprintPositions) {
    await client.query(
      `insert into question_bank_versions
         (question_id, content_version, domain, source_wording, rubric, follow_up_goals,
          knowledge_explanation, import_source_name, import_source_version)
       values ($1, 1, 'go_language', $2, '[]', '[]', 'Explanation', 'constraint-fixture', 1)
       on conflict do nothing`,
      [`constraint-question-${position}`, `Question ${position}`],
    );
  }
}

async function insertInterviewBlueprint(
  client: PoolClient,
  interviewId: string,
  ownerUserId: string,
  positions: readonly number[] = blueprintPositions,
  status = "active",
): Promise<void> {
  await client.query(
    `insert into interview_sessions
       (id, owner_user_id, selected_question_count, selection_seed, status)
     values ($1, $2, 5, $3, $4)`,
    [interviewId, ownerUserId, `${interviewId}-seed`, status],
  );

  for (const [index, position] of positions.entries()) {
    const sourcePosition = Math.min(Math.max(position, 1), 5);
    await client.query(
      `insert into session_question_snapshots
         (id, interview_id, position, source_question_id, source_question_version, domain,
          source_wording, display_wording, rubric, follow_up_goals, knowledge_explanation)
       values ($1, $2, $3, $4, 1, 'go_language', $5, $5, '[]', '[]', 'Explanation')`,
      [
        `${interviewId}-snapshot-${index + 1}`,
        interviewId,
        position,
        `constraint-question-${sourcePosition}`,
        `Question ${sourcePosition}`,
      ],
    );
  }
}

async function createInterviewWithBlueprint(
  pool: Pool,
  interviewId: string,
  ownerUserId: string,
  status = "active",
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("begin");
    await seedConstraintQuestions(client);
    await insertInterviewBlueprint(client, interviewId, ownerUserId, blueprintPositions, status);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function databaseUrlFor(baseDatabaseUrl: string, databaseName: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function recreateDatabase(baseDatabaseUrl: string, databaseName: string): Promise<string> {
  if (!/^[a-z][a-z0-9_]*$/.test(databaseName)) {
    throw new Error(`Unsafe test database name: ${databaseName}`);
  }

  const adminPool = new Pool({ connectionString: baseDatabaseUrl });
  try {
    await adminPool.query(`drop database if exists "${databaseName}" with (force)`);
    await adminPool.query(`create database "${databaseName}"`);
  } finally {
    await adminPool.end();
  }

  return databaseUrlFor(baseDatabaseUrl, databaseName);
}

async function dropDatabase(baseDatabaseUrl: string, databaseName: string): Promise<void> {
  const adminPool = new Pool({ connectionString: baseDatabaseUrl });
  try {
    await adminPool.query(`drop database if exists "${databaseName}" with (force)`);
  } finally {
    await adminPool.end();
  }
}

async function applySqlMigration(pool: Pool, migrationName: string): Promise<void> {
  const sql = await readFile(resolve(migrationsRoot, migrationName), "utf8");
  const statements = sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  const client = await pool.connect();

  try {
    await client.query("begin");
    for (const statement of statements) {
      await client.query(statement);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function applyInitialMigrations(pool: Pool): Promise<void> {
  for (const migrationName of initialMigrationNames) {
    await applySqlMigration(pool, migrationName);
  }
}

async function seedUpgradeBlueprint(
  pool: Pool,
  interviewId: string,
  positions: readonly number[],
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("begin");
    await client.query(
      `insert into "user" (id, name, email)
       values ('upgrade-owner', 'Upgrade Owner', 'upgrade-owner@example.com')`,
    );
    await seedConstraintQuestions(client);
    await insertInterviewBlueprint(client, interviewId, "upgrade-owner", positions, "completed");
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
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
      const jsonColumns = await pool.query<{ column_name: string; table_name: string }>(
        `select table_name, column_name
           from information_schema.columns
          where table_schema = 'public' and data_type = 'jsonb'
          order by table_name, ordinal_position`,
      );
      const timestampColumns = await pool.query<{
        column_name: string;
        data_type: string;
        table_name: string;
      }>(
        `select table_name, column_name, data_type
           from information_schema.columns
          where table_schema = 'public' and data_type like 'timestamp%'
          order by table_name, ordinal_position`,
      );
      const purgeAuditColumns = await pool.query<{ column_name: string }>(
        `select column_name
           from information_schema.columns
          where table_schema = 'public' and table_name = 'purge_audit_events'
          order by ordinal_position`,
      );

      expect(tables.rows.map((row) => row.table_name)).toEqual([
        "account",
        "deletion_requests",
        "interview_messages",
        "interview_sessions",
        "operations",
        "purge_audit_events",
        "question_bank_versions",
        "question_evaluations",
        "reports",
        "session",
        "session_question_snapshots",
        "user",
        "verification",
      ]);
      expect(jsonColumns.rows).toEqual([
        { table_name: "deletion_requests", column_name: "result" },
        { table_name: "deletion_requests", column_name: "error" },
        { table_name: "interview_messages", column_name: "metadata" },
        { table_name: "operations", column_name: "input" },
        { table_name: "operations", column_name: "result" },
        { table_name: "operations", column_name: "error" },
        { table_name: "question_bank_versions", column_name: "rubric" },
        { table_name: "question_bank_versions", column_name: "follow_up_goals" },
        { table_name: "question_evaluations", column_name: "rubric_results" },
        { table_name: "question_evaluations", column_name: "model_metadata" },
        { table_name: "reports", column_name: "snapshot" },
        { table_name: "reports", column_name: "model_metadata" },
        { table_name: "session_question_snapshots", column_name: "rubric" },
        { table_name: "session_question_snapshots", column_name: "follow_up_goals" },
      ]);
      const frameworkTimestampColumns = timestampColumns.rows.filter(
        (column) =>
          ["account", "session", "user", "verification"].includes(column.table_name) &&
          !(column.table_name === "user" && column.column_name === "deletion_requested_at"),
      );
      const businessTimestampColumns = timestampColumns.rows.filter(
        (column) => !frameworkTimestampColumns.includes(column),
      );
      expect(frameworkTimestampColumns.length).toBeGreaterThan(0);
      expect(
        frameworkTimestampColumns.every(
          (column) => column.data_type === "timestamp without time zone",
        ),
      ).toBe(true);
      expect(businessTimestampColumns.length).toBeGreaterThan(0);
      expect(
        businessTimestampColumns.every((column) => column.data_type === "timestamp with time zone"),
      ).toBe(true);
      expect(purgeAuditColumns.rows.map((row) => row.column_name)).toEqual([
        "subject_identifier_hash",
        "data_category",
        "result",
        "purged_at",
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

      await pool.query(
        `insert into "user" (id, name, email)
         values ('user-3', 'Business Owner', 'business-owner@example.com')`,
      );
      await createInterviewWithBlueprint(pool, "interview-1", "user-3");
      await expect(pool.query(`delete from "user" where id = 'user-3'`)).rejects.toMatchObject({
        code: "23001",
        constraint: "interview_sessions_owner_user_id_user_id_fk",
      });
      await pool.query(`delete from interview_sessions where id = 'interview-1'`);
      await pool.query(`delete from "user" where id = 'user-3'`);
    } finally {
      await pool.end();
    }
  }, 120_000);

  it("rejects upgrading an incomplete or gapped blueprint created under migration 0001", async () => {
    const databaseName = "upgrade_invalid_blueprint";
    const upgradeDatabaseUrl = await recreateDatabase(databaseUrl, databaseName);
    const pool = new Pool({ connectionString: upgradeDatabaseUrl });

    try {
      await applyInitialMigrations(pool);
      await seedUpgradeBlueprint(pool, "invalid-upgrade-interview", [1, 2, 4, 5]);

      await expect(applySqlMigration(pool, "0002_interview_constraints.sql")).rejects.toMatchObject(
        {
          code: "23514",
          constraint: "session_question_snapshots_complete_blueprint_check",
        },
      );

      const rolledBackFunction = await pool.query<{ function_count: string }>(
        `select count(*)::text as function_count
           from pg_proc
          where proname = 'assert_interview_blueprint_complete'`,
      );
      expect(rolledBackFunction.rows[0]?.function_count).toBe("0");
    } finally {
      await pool.end();
      await dropDatabase(databaseUrl, databaseName);
    }
  }, 120_000);

  it("upgrades valid existing migration-0001 blueprints successfully", async () => {
    const databaseName = "upgrade_valid_blueprint";
    const upgradeDatabaseUrl = await recreateDatabase(databaseUrl, databaseName);
    const pool = new Pool({ connectionString: upgradeDatabaseUrl });

    try {
      await applyInitialMigrations(pool);
      await seedUpgradeBlueprint(pool, "valid-upgrade-interview", blueprintPositions);

      await expect(
        applySqlMigration(pool, "0002_interview_constraints.sql"),
      ).resolves.toBeUndefined();

      const migrationObjects = await pool.query<{ object_name: string }>(
        `select proname as object_name
           from pg_proc
          where proname in (
            'assert_interview_blueprint_complete',
            'prevent_operation_delete_while_interview_exists',
            'prevent_session_question_snapshot_delete_while_interview_exists'
          )
          order by proname`,
      );
      expect(migrationObjects.rows.map((row) => row.object_name)).toEqual([
        "assert_interview_blueprint_complete",
        "prevent_operation_delete_while_interview_exists",
        "prevent_session_question_snapshot_delete_while_interview_exists",
      ]);
    } finally {
      await pool.end();
      await dropDatabase(databaseUrl, databaseName);
    }
  }, 120_000);

  it("rejects cross-owner and cross-interview aggregate links", async () => {
    const pool = new Pool({ connectionString: databaseUrl });

    try {
      await pool.query(
        `insert into "user" (id, name, email)
         values ('aggregate-owner-a', 'Owner A', 'aggregate-a@example.com'),
                ('aggregate-owner-b', 'Owner B', 'aggregate-b@example.com')`,
      );
      await createInterviewWithBlueprint(pool, "aggregate-interview-a", "aggregate-owner-a");
      await createInterviewWithBlueprint(pool, "aggregate-interview-b", "aggregate-owner-b");
      await pool.query(
        `insert into operations
           (id, owner_user_id, interview_id, idempotency_scope, idempotency_key, type,
            expected_version, input)
         values ('aggregate-operation-a', 'aggregate-owner-a', 'aggregate-interview-a',
                 'submit_answer', 'operation-a', 'submit_answer', 1, '{}')`,
      );

      await expect(
        pool.query(
          `insert into operations
             (id, owner_user_id, interview_id, idempotency_scope, idempotency_key, type,
              expected_version, input)
           values ('cross-owner-operation', 'aggregate-owner-b', 'aggregate-interview-a',
                   'submit_answer', 'cross-owner', 'submit_answer', 1, '{}')`,
        ),
      ).rejects.toMatchObject({ code: "23503", constraint: "operations_interview_owner_fk" });

      await expect(
        pool.query(
          `insert into reports
             (id, interview_id, owner_user_id, kind, schema_version, snapshot, model_metadata)
           values ('cross-owner-report', 'aggregate-interview-a', 'aggregate-owner-b',
                   'complete', '1', '{}', '{}')`,
        ),
      ).rejects.toMatchObject({ code: "23503", constraint: "reports_interview_owner_fk" });

      await expect(
        pool.query(
          `insert into deletion_requests
             (id, owner_user_id, scope, interview_id, purge_due_at)
           values ('cross-owner-deletion', 'aggregate-owner-b', 'interview',
                   'aggregate-interview-a', now() + interval '1 day')`,
        ),
      ).rejects.toMatchObject({
        code: "23503",
        constraint: "deletion_requests_interview_owner_fk",
      });

      await expect(
        pool.query(
          `insert into deletion_requests
             (id, owner_user_id, scope, interview_id, purge_due_at)
           values ('account-deletion-with-interview', 'aggregate-owner-a', 'account',
                   'aggregate-interview-a', now() + interval '1 day')`,
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "deletion_requests_scope_target_check",
      });

      await expect(
        pool.query(
          `insert into deletion_requests
             (id, owner_user_id, scope, purge_due_at)
           values ('interview-deletion-without-interview', 'aggregate-owner-a', 'interview',
                   now() + interval '1 day')`,
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "deletion_requests_scope_target_check",
      });

      await expect(
        pool.query(
          `insert into interview_messages
             (id, interview_id, question_snapshot_id, role, kind, content)
           values ('cross-interview-snapshot-message', 'aggregate-interview-b',
                   'aggregate-interview-a-snapshot-1', 'assistant', 'main_question', 'Question')`,
        ),
      ).rejects.toMatchObject({
        code: "23503",
        constraint: "interview_messages_snapshot_aggregate_fk",
      });

      await expect(
        pool.query(
          `insert into interview_messages
             (id, interview_id, role, kind, content, operation_id)
           values ('cross-interview-operation-message', 'aggregate-interview-b',
                   'assistant', 'transition', 'Transition', 'aggregate-operation-a')`,
        ),
      ).rejects.toMatchObject({
        code: "23503",
        constraint: "interview_messages_operation_aggregate_fk",
      });
    } finally {
      await pool.end();
    }
  });

  it("enforces evaluation and snapshot outcome integrity", async () => {
    const pool = new Pool({ connectionString: databaseUrl });

    try {
      const validEvaluations = [
        ["valid-scored-evaluation", "relevant", "scored", 75, null],
        ["valid-incorrect-evaluation", "ambiguous", "incorrect", 0, "incorrect"],
        ["valid-irrelevant-evaluation", "irrelevant", "irrelevant", 0, "irrelevant"],
      ] as const;

      for (const [id, classification, outcome, score, reason] of validEvaluations) {
        await pool.query(
          `insert into question_evaluations
             (id, question_snapshot_id, classification, rubric_results, outcome_kind, score,
              zero_score_reason, model_metadata)
             values ($1, 'aggregate-interview-a-snapshot-1', $2, '[]', $3, $4, $5, '{}')`,
          [id, classification, outcome, score, reason],
        );
      }

      for (const outcome of ["unknown", "skipped"]) {
        await expect(
          pool.query(
            `insert into question_evaluations
               (id, question_snapshot_id, classification, rubric_results, outcome_kind, score,
                zero_score_reason, model_metadata)
               values ($1, 'aggregate-interview-a-snapshot-1', 'relevant', '[]',
                     $2::text::evaluation_outcome_kind, 0, null, '{}')`,
            [`invalid-evaluation-${outcome}`, outcome],
          ),
        ).rejects.toMatchObject({ code: "22P02" });
      }

      const invalidEvaluations = [
        ["invalid-scored-zero", "relevant", "scored", 0, null],
        ["invalid-scored-irrelevant", "irrelevant", "scored", 50, null],
        ["invalid-incorrect-score", "relevant", "incorrect", 1, "incorrect"],
        ["invalid-incorrect-reason", "relevant", "incorrect", 0, null],
        ["invalid-incorrect-classification", "irrelevant", "incorrect", 0, "incorrect"],
        ["invalid-irrelevant-reason", "irrelevant", "irrelevant", 0, "incorrect"],
      ] as const;

      for (const [id, classification, outcome, score, reason] of invalidEvaluations) {
        await expect(
          pool.query(
            `insert into question_evaluations
               (id, question_snapshot_id, classification, rubric_results, outcome_kind, score,
                zero_score_reason, model_metadata)
               values ($1, 'aggregate-interview-a-snapshot-1', $2, '[]', $3, $4, $5, '{}')`,
            [id, classification, outcome, score, reason],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "question_evaluations_outcome_integrity_check",
        });
      }

      const validSnapshotOutcomes = [
        ["snapshot-scored", "scored", 100, null],
        ["snapshot-incorrect", "incorrect", 0, "incorrect"],
        ["snapshot-irrelevant", "irrelevant", 0, "irrelevant"],
        ["snapshot-unknown", "unknown", 0, "unknown"],
        ["snapshot-skipped", "skipped", 0, "skipped"],
      ] as const;

      for (const [index, [, outcome, score, reason]] of validSnapshotOutcomes.entries()) {
        await pool.query(
          `update session_question_snapshots
              set outcome_kind = $1, score = $2, zero_score_reason = $3
            where id = $4`,
          [outcome, score, reason, `aggregate-interview-a-snapshot-${index + 1}`],
        );
      }

      const invalidSnapshotOutcomes = [
        ["snapshot-invalid-scored", "scored", 0, null],
        ["snapshot-invalid-incorrect", "incorrect", 0, null],
        ["snapshot-invalid-irrelevant", "irrelevant", 0, "incorrect"],
        ["snapshot-invalid-unknown", "unknown", 0, "skipped"],
        ["snapshot-invalid-skipped", "skipped", null, "skipped"],
      ] as const;

      for (const [, outcome, score, reason] of invalidSnapshotOutcomes) {
        await expect(
          pool.query(
            `update session_question_snapshots
                set outcome_kind = $1, score = $2, zero_score_reason = $3
              where id = 'aggregate-interview-a-snapshot-1'`,
            [outcome, score, reason],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "session_question_snapshots_outcome_integrity_check",
        });
      }
    } finally {
      await pool.end();
    }
  });

  it("allows at most one active or report-pending interview, including concurrent inserts", async () => {
    const pool = new Pool({ connectionString: databaseUrl });

    try {
      await pool.query(
        `insert into "user" (id, name, email)
         values ('open-owner', 'Open Owner', 'open-owner@example.com'),
                ('concurrent-owner', 'Concurrent Owner', 'concurrent-owner@example.com')`,
      );

      await createInterviewWithBlueprint(pool, "open-interview-1", "open-owner");
      await expect(
        createInterviewWithBlueprint(pool, "blocked-active-interview", "open-owner"),
      ).rejects.toMatchObject({
        code: "23505",
        constraint: "interview_sessions_one_open_per_user_idx",
      });

      await pool.query(
        `update interview_sessions set status = 'report_pending' where id = 'open-interview-1'`,
      );
      await expect(
        createInterviewWithBlueprint(pool, "blocked-report-interview", "open-owner"),
      ).rejects.toMatchObject({
        code: "23505",
        constraint: "interview_sessions_one_open_per_user_idx",
      });

      let openInterviewId = "open-interview-1";
      for (const [index, terminalStatus] of [
        "completed",
        "early_ended",
        "abandoned",
        "deleting",
      ].entries()) {
        await pool.query(`update interview_sessions set status = $1 where id = $2`, [
          terminalStatus,
          openInterviewId,
        ]);
        openInterviewId = `terminal-allowance-${index}`;
        await createInterviewWithBlueprint(pool, openInterviewId, "open-owner");
      }

      const concurrentResults = await Promise.allSettled([
        createInterviewWithBlueprint(pool, "concurrent-interview-a", "concurrent-owner"),
        createInterviewWithBlueprint(pool, "concurrent-interview-b", "concurrent-owner"),
      ]);

      expect(concurrentResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejectedConcurrentInsert = concurrentResults.find(
        (result) => result.status === "rejected",
      );
      expect(rejectedConcurrentInsert).toMatchObject({
        status: "rejected",
        reason: {
          code: "23505",
          constraint: "interview_sessions_one_open_per_user_idx",
        },
      });
    } finally {
      await pool.end();
    }
  });

  it("requires a unique contiguous complete blueprint within the selected question count", async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const client = await pool.connect();

    try {
      await pool.query(
        `insert into "user" (id, name, email)
         values ('blueprint-owner', 'Blueprint Owner', 'blueprint-owner@example.com')`,
      );
      await seedConstraintQuestions(client);
      await createInterviewWithBlueprint(
        pool,
        "valid-blueprint-interview",
        "blueprint-owner",
        "completed",
      );

      await client.query("begin");
      await insertInterviewBlueprint(
        client,
        "duplicate-blueprint-interview",
        "blueprint-owner",
        [1, 2, 3, 4],
        "completed",
      );
      await expect(
        client.query(
          `insert into session_question_snapshots
             (id, interview_id, position, source_question_id, source_question_version, domain,
              source_wording, display_wording, rubric, follow_up_goals, knowledge_explanation)
           values ('duplicate-blueprint-position', 'duplicate-blueprint-interview', 4,
                   'constraint-question-5', 1, 'go_language', 'Question 5', 'Question 5',
                   '[]', '[]', 'Explanation')`,
        ),
      ).rejects.toMatchObject({
        code: "23505",
        constraint: "session_question_snapshots_interview_position_unique",
      });
      await client.query("rollback");

      for (const [interviewId, positions] of [
        ["gapped-blueprint-interview", [1, 2, 4, 5]],
        ["out-of-range-blueprint-interview", [1, 2, 3, 4, 6]],
      ] as const) {
        await client.query("begin");
        await insertInterviewBlueprint(
          client,
          interviewId,
          "blueprint-owner",
          positions,
          "completed",
        );
        await expect(client.query("commit")).rejects.toMatchObject({
          code: "23514",
          constraint: "session_question_snapshots_complete_blueprint_check",
        });
        await client.query("rollback");
      }

      await client.query("begin");
      await client.query(
        `insert into interview_sessions
           (id, owner_user_id, selected_question_count, selection_seed, status)
         values ('negative-position-interview', 'blueprint-owner', 5, 'negative-seed',
                 'completed')`,
      );
      await expect(
        client.query(
          `insert into session_question_snapshots
             (id, interview_id, position, source_question_id, source_question_version, domain,
              source_wording, display_wording, rubric, follow_up_goals, knowledge_explanation)
           values ('negative-position-snapshot', 'negative-position-interview', 0,
                   'constraint-question-1', 1, 'go_language', 'Question 1', 'Question 1',
                   '[]', '[]', 'Explanation')`,
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "session_question_snapshots_position_check",
      });
      await client.query("rollback");
    } finally {
      client.release();
      await pool.end();
    }
  });

  it("freezes interview blueprint ownership and selection while allowing lifecycle updates", async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const client = await pool.connect();

    try {
      await pool.query(
        `insert into "user" (id, name, email)
         values ('frozen-blueprint-owner', 'Frozen Blueprint Owner',
                 'frozen-blueprint-owner@example.com'),
                ('frozen-blueprint-new-owner', 'Frozen Blueprint New Owner',
                 'frozen-blueprint-new-owner@example.com')`,
      );
      await createInterviewWithBlueprint(
        pool,
        "frozen-blueprint-interview",
        "frozen-blueprint-owner",
      );

      for (const update of [
        "selected_question_count = 10",
        "selection_seed = 'changed-seed'",
        "owner_user_id = 'frozen-blueprint-new-owner'",
      ]) {
        await expect(
          pool.query(
            `update interview_sessions
                set ${update}
              where id = 'frozen-blueprint-interview'`,
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "interview_sessions_immutable_blueprint_check",
        });
      }

      await client.query("begin");
      await client.query(
        `insert into session_question_snapshots
           (id, interview_id, position, source_question_id, source_question_version, domain,
            source_wording, display_wording, rubric, follow_up_goals, knowledge_explanation)
         values ('frozen-blueprint-extra-snapshot', 'frozen-blueprint-interview', 6,
                 'constraint-question-5', 1, 'go_language', 'Question 5', 'Question 5',
                 '[]', '[]', 'Explanation')`,
      );
      await expect(client.query("commit")).rejects.toMatchObject({
        code: "23514",
        constraint: "session_question_snapshots_complete_blueprint_check",
      });
      await client.query("rollback");

      await expect(
        pool.query(
          `update interview_sessions
              set status = 'report_pending', active_phase = 'processing', version = version + 1,
                  current_question_position = 5, last_effective_activity_at = now(),
                  pending_operation_kind = 'answer_analysis',
                  pending_operation_question_position = 5,
                  pending_operation_accepted_at = now(),
                  pending_operation_previous_phase = 'awaiting_response',
                  pending_report_kind = 'complete', report_requested_at = now()
            where id = 'frozen-blueprint-interview'`,
        ),
      ).resolves.toMatchObject({ rowCount: 1 });

      const mutableState = await pool.query<{
        active_phase: string;
        current_question_position: number;
        last_effective_activity_at: Date;
        pending_operation_accepted_at: Date;
        pending_operation_kind: string;
        pending_operation_previous_phase: string;
        pending_operation_question_position: number;
        pending_report_kind: string;
        report_requested_at: Date;
        status: string;
        version: number;
      }>(
        `select status, active_phase, version, current_question_position,
                last_effective_activity_at,
                pending_operation_kind, pending_operation_question_position,
                pending_operation_accepted_at, pending_operation_previous_phase,
                pending_report_kind, report_requested_at
           from interview_sessions
          where id = 'frozen-blueprint-interview'`,
      );
      expect(mutableState.rows[0]).toMatchObject({
        status: "report_pending",
        active_phase: "processing",
        version: 2,
        current_question_position: 5,
        pending_operation_kind: "answer_analysis",
        pending_operation_question_position: 5,
        pending_operation_previous_phase: "awaiting_response",
        pending_report_kind: "complete",
      });
      expect(mutableState.rows[0]?.last_effective_activity_at).toBeInstanceOf(Date);
      expect(mutableState.rows[0]?.pending_operation_accepted_at).toBeInstanceOf(Date);
      expect(mutableState.rows[0]?.report_requested_at).toBeInstanceOf(Date);
    } finally {
      client.release();
      await pool.end();
    }
  });

  it("rejects snapshot identity/content and Operation command-input updates", async () => {
    const pool = new Pool({ connectionString: databaseUrl });

    try {
      await pool.query(
        `insert into "user" (id, name, email)
         values ('immutable-owner', 'Immutable Owner', 'immutable-owner@example.com')`,
      );
      await createInterviewWithBlueprint(pool, "immutable-interview", "immutable-owner");
      await pool.query(
        `insert into operations
           (id, owner_user_id, interview_id, idempotency_scope, idempotency_key, type,
            expected_version, input)
         values ('immutable-operation', 'immutable-owner', 'immutable-interview',
                 'submit_answer', 'immutable-key', 'submit_answer', 1, '{"answer":"original"}')`,
      );

      for (const update of [
        "source_question_id = 'constraint-question-2'",
        "source_question_version = 2",
        "position = 2",
        "interview_id = 'aggregate-interview-a'",
        "display_wording = 'Changed wording'",
        'rubric = \'[{"id":"changed"}]\'::jsonb',
      ]) {
        await expect(
          pool.query(
            `update session_question_snapshots
                set ${update}
              where id = 'immutable-interview-snapshot-1'`,
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "session_question_snapshots_immutable_check",
        });
      }

      await expect(
        pool.query(
          `update session_question_snapshots
              set frozen = true, frozen_at = now(),
                  outcome_kind = 'unknown', score = 0, zero_score_reason = 'unknown'
            where id = 'immutable-interview-snapshot-1'`,
        ),
      ).resolves.toMatchObject({ rowCount: 1 });

      for (const update of [
        "id = 'changed-operation-id'",
        "idempotency_key = 'changed-key'",
        "idempotency_scope = 'submit_supplement'",
        "expected_version = 2",
        'input = \'{"answer":"changed"}\'::jsonb',
      ]) {
        await expect(
          pool.query(`update operations set ${update} where id = 'immutable-operation'`),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "operations_immutable_input_check",
        });
      }

      await expect(
        pool.query(
          `update operations
              set status = 'failed', error = '{"code":"provider_error"}', completed_at = now()
            where id = 'immutable-operation'`,
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await pool.end();
    }
  });

  it("rejects direct child deletion and replacement but permits physical purge cascades", async () => {
    const pool = new Pool({ connectionString: databaseUrl });

    try {
      await pool.query(
        `insert into "user" (id, name, email)
         values ('purge-owner', 'Purge Owner', 'purge-owner@example.com')`,
      );
      await pool.query(
        `insert into account (id, account_id, provider_id, user_id, updated_at)
         values ('purge-account', 'purge-external', 'github', 'purge-owner', now());
         insert into session (id, expires_at, token, updated_at, user_id)
         values ('purge-session', now() + interval '1 day', 'purge-token', now(), 'purge-owner')`,
      );
      await createInterviewWithBlueprint(pool, "purge-interview", "purge-owner");
      await pool.query(
        `insert into operations
           (id, owner_user_id, interview_id, idempotency_scope, idempotency_key, type,
            expected_version, input)
         values ('purge-operation', 'purge-owner', 'purge-interview',
                 'submit_answer', 'purge-key', 'submit_answer', 1, '{"answer":"original"}')`,
      );

      await expect(
        pool.query(
          `delete from session_question_snapshots
            where id = 'purge-interview-snapshot-1'`,
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "session_question_snapshots_immutable_delete_check",
      });
      await expect(
        pool.query(`delete from operations where id = 'purge-operation'`),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "operations_immutable_input_delete_check",
      });

      await expect(
        pool.query(
          `with removed as (
             delete from session_question_snapshots
              where id = 'purge-interview-snapshot-1'
              returning id
           )
           insert into session_question_snapshots
             (id, interview_id, position, source_question_id, source_question_version, domain,
              source_wording, display_wording, rubric, follow_up_goals, knowledge_explanation)
           select id, 'purge-interview', 1, 'constraint-question-1', 1, 'go_language',
                  'Question 1', 'Replacement wording', '[]', '[]', 'Replacement explanation'
             from removed`,
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "session_question_snapshots_immutable_delete_check",
      });
      await expect(
        pool.query(
          `with removed as (
             delete from operations
              where id = 'purge-operation'
              returning id
           )
           insert into operations
             (id, owner_user_id, interview_id, idempotency_scope, idempotency_key, type,
              expected_version, input)
           select id, 'purge-owner', 'purge-interview', 'submit_answer', 'purge-key',
                  'submit_answer', 1, '{"answer":"original"}'
             from removed`,
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "operations_immutable_input_delete_check",
      });

      await expect(
        pool.query(`delete from interview_sessions where id = 'purge-interview'`),
      ).resolves.toMatchObject({ rowCount: 1 });
      const aggregateChildren = await pool.query<{ operations: string; snapshots: string }>(
        `select
           (select count(*)::text from operations where interview_id = 'purge-interview')
             as operations,
           (select count(*)::text from session_question_snapshots
             where interview_id = 'purge-interview') as snapshots`,
      );
      expect(aggregateChildren.rows[0]).toEqual({ operations: "0", snapshots: "0" });

      await expect(
        pool.query(`delete from "user" where id = 'purge-owner'`),
      ).resolves.toMatchObject({ rowCount: 1 });
      const authenticationChildren = await pool.query<{ accounts: string; sessions: string }>(
        `select
           (select count(*)::text from account where user_id = 'purge-owner') as accounts,
           (select count(*)::text from session where user_id = 'purge-owner') as sessions`,
      );
      expect(authenticationChildren.rows[0]).toEqual({ accounts: "0", sessions: "0" });
    } finally {
      await pool.end();
    }
  });

  it("scopes idempotency keys by authenticated user and command type", async () => {
    const pool = new Pool({ connectionString: databaseUrl });

    try {
      await pool.query(
        `insert into "user" (id, name, email)
         values ('idempotency-owner-a', 'Idempotency A', 'idempotency-a@example.com'),
                ('idempotency-owner-b', 'Idempotency B', 'idempotency-b@example.com')`,
      );
      await createInterviewWithBlueprint(pool, "idempotency-interview-a", "idempotency-owner-a");
      await createInterviewWithBlueprint(pool, "idempotency-interview-b", "idempotency-owner-b");

      await pool.query(
        `insert into operations
           (id, owner_user_id, interview_id, idempotency_scope, idempotency_key, type,
            expected_version, input)
         values ('idempotency-operation-a', 'idempotency-owner-a', 'idempotency-interview-a',
                 'submit_answer', 'shared-key', 'submit_answer', 1, '{}')`,
      );
      await expect(
        pool.query(
          `insert into operations
             (id, owner_user_id, interview_id, idempotency_scope, idempotency_key, type,
              expected_version, input)
           values ('idempotency-duplicate', 'idempotency-owner-a', 'idempotency-interview-a',
                   'submit_answer', 'shared-key', 'submit_answer', 1, '{}')`,
        ),
      ).rejects.toMatchObject({
        code: "23505",
        constraint: "operations_owner_scope_idempotency_unique",
      });
      await expect(
        pool.query(
          `insert into operations
             (id, owner_user_id, interview_id, idempotency_scope, idempotency_key, type,
              expected_version, input)
           values ('idempotency-other-scope', 'idempotency-owner-a', 'idempotency-interview-a',
                   'submit_supplement', 'shared-key', 'submit_supplement', 1, '{}'),
                  ('idempotency-other-user', 'idempotency-owner-b', 'idempotency-interview-b',
                   'submit_answer', 'shared-key', 'submit_answer', 1, '{}')`,
        ),
      ).resolves.toMatchObject({ rowCount: 2 });
      await expect(
        pool.query(
          `insert into operations
             (id, owner_user_id, interview_id, idempotency_scope, idempotency_key, type,
              expected_version, input)
           values ('idempotency-scope-mismatch', 'idempotency-owner-a',
                   'idempotency-interview-a', 'submit_answer', 'mismatched-scope',
                   'submit_supplement', 1, '{}')`,
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "operations_idempotency_scope_check",
      });
    } finally {
      await pool.end();
    }
  });

  it("enforces Operation version and processing lease consistency without lease behavior", async () => {
    const pool = new Pool({ connectionString: databaseUrl });

    try {
      for (const [id, columns, values, constraint] of [
        ["negative-version", "", "", "operations_expected_version_check"],
        [
          "pending-with-lease",
          ", lease_acquired_at, lease_expires_at",
          ", now(), now() + interval '1 minute'",
          "operations_status_lease_check",
        ],
        ["processing-without-lease", ", status", ", 'processing'", "operations_status_lease_check"],
      ] as const) {
        await expect(
          pool.query(
            `insert into operations
               (id, owner_user_id, interview_id, idempotency_scope, idempotency_key, type,
                expected_version, input${columns})
             values ($1, 'aggregate-owner-a', 'aggregate-interview-a', 'submit_answer', $1,
                     'submit_answer', $2, '{}'${values})`,
            [id, id === "negative-version" ? -1 : 1],
          ),
        ).rejects.toMatchObject({ code: "23514", constraint });
      }

      await expect(
        pool.query(
          `insert into operations
             (id, owner_user_id, interview_id, idempotency_scope, idempotency_key, type,
              status, expected_version, input, lease_acquired_at, lease_expires_at)
           values ('valid-processing-lease', 'aggregate-owner-a', 'aggregate-interview-a',
                   'submit_answer', 'valid-processing-lease', 'submit_answer', 'processing', 1,
                   '{}', now(), now() + interval '1 minute')`,
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await pool.end();
    }
  });
});
