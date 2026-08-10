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
      await pool.query(
        `insert into interview_sessions
           (id, owner_user_id, selected_question_count, selection_seed)
         values ('interview-1', 'user-3', 5, 'selection-seed')`,
      );
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

  it("rejects cross-owner and cross-interview aggregate links", async () => {
    const pool = new Pool({ connectionString: databaseUrl });

    try {
      await pool.query(
        `insert into "user" (id, name, email)
         values ('aggregate-owner-a', 'Owner A', 'aggregate-a@example.com'),
                ('aggregate-owner-b', 'Owner B', 'aggregate-b@example.com')`,
      );
      await pool.query(
        `insert into interview_sessions
           (id, owner_user_id, selected_question_count, selection_seed)
         values ('aggregate-interview-a', 'aggregate-owner-a', 5, 'seed-a'),
                ('aggregate-interview-b', 'aggregate-owner-b', 5, 'seed-b')`,
      );
      await pool.query(
        `insert into question_bank_versions
           (question_id, content_version, domain, source_wording, rubric, follow_up_goals,
            knowledge_explanation, import_source_name, import_source_version)
         values ('aggregate-question', 1, 'go_language', 'Question', '[]', '[]',
                 'Explanation', 'fixture', 1)`,
      );
      await pool.query(
        `insert into session_question_snapshots
           (id, interview_id, position, source_question_id, source_question_version, domain,
            source_wording, display_wording, rubric, follow_up_goals, knowledge_explanation)
         values ('aggregate-snapshot-a', 'aggregate-interview-a', 1, 'aggregate-question', 1,
                 'go_language', 'Question', 'Question', '[]', '[]', 'Explanation'),
                ('aggregate-snapshot-b', 'aggregate-interview-b', 1, 'aggregate-question', 1,
                 'go_language', 'Question', 'Question', '[]', '[]', 'Explanation')`,
      );
      await pool.query(
        `insert into operations
           (id, owner_user_id, interview_id, idempotency_scope, idempotency_key, type,
            expected_version, input)
         values ('aggregate-operation-a', 'aggregate-owner-a', 'aggregate-interview-a',
                 'answer', 'operation-a', 'submit_answer', 1, '{}')`,
      );

      await expect(
        pool.query(
          `insert into operations
             (id, owner_user_id, interview_id, idempotency_scope, idempotency_key, type,
              expected_version, input)
           values ('cross-owner-operation', 'aggregate-owner-b', 'aggregate-interview-a',
                   'answer', 'cross-owner', 'submit_answer', 1, '{}')`,
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
                   'aggregate-snapshot-a', 'assistant', 'main_question', 'Question')`,
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
           values ($1, 'aggregate-snapshot-a', $2, '[]', $3, $4, $5, '{}')`,
          [id, classification, outcome, score, reason],
        );
      }

      for (const outcome of ["unknown", "skipped"]) {
        await expect(
          pool.query(
            `insert into question_evaluations
               (id, question_snapshot_id, classification, rubric_results, outcome_kind, score,
                zero_score_reason, model_metadata)
             values ($1, 'aggregate-snapshot-a', 'relevant', '[]',
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
             values ($1, 'aggregate-snapshot-a', $2, '[]', $3, $4, $5, '{}')`,
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

      for (const [id, outcome, score, reason] of validSnapshotOutcomes) {
        await pool.query(
          `insert into session_question_snapshots
             (id, interview_id, position, source_question_id, source_question_version, domain,
              source_wording, display_wording, rubric, follow_up_goals, knowledge_explanation,
              outcome_kind, score, zero_score_reason)
           values ($1, 'aggregate-interview-a', 2, 'aggregate-question', 1, 'go_language',
                   'Question', 'Question', '[]', '[]', 'Explanation', $2, $3, $4)`,
          [id, outcome, score, reason],
        );
      }

      const invalidSnapshotOutcomes = [
        ["snapshot-invalid-scored", "scored", 0, null],
        ["snapshot-invalid-incorrect", "incorrect", 0, null],
        ["snapshot-invalid-irrelevant", "irrelevant", 0, "incorrect"],
        ["snapshot-invalid-unknown", "unknown", 0, "skipped"],
        ["snapshot-invalid-skipped", "skipped", null, "skipped"],
      ] as const;

      for (const [id, outcome, score, reason] of invalidSnapshotOutcomes) {
        await expect(
          pool.query(
            `insert into session_question_snapshots
               (id, interview_id, position, source_question_id, source_question_version, domain,
                source_wording, display_wording, rubric, follow_up_goals, knowledge_explanation,
                outcome_kind, score, zero_score_reason)
             values ($1, 'aggregate-interview-a', 3, 'aggregate-question', 1, 'go_language',
                     'Question', 'Question', '[]', '[]', 'Explanation', $2, $3, $4)`,
            [id, outcome, score, reason],
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

  it("keeps task 3.3 business uniqueness explicitly deferred", async () => {
    const pool = new Pool({ connectionString: databaseUrl });

    try {
      await expect(
        pool.query(
          `insert into interview_sessions
             (id, owner_user_id, selected_question_count, selection_seed)
           values ('second-active-interview', 'aggregate-owner-a', 5, 'second-seed')`,
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        pool.query(
          `insert into session_question_snapshots
             (id, interview_id, position, source_question_id, source_question_version, domain,
              source_wording, display_wording, rubric, follow_up_goals, knowledge_explanation)
           values ('duplicate-position-snapshot', 'aggregate-interview-a', 1,
                   'aggregate-question', 1, 'go_language', 'Question', 'Question', '[]', '[]',
                   'Explanation')`,
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        pool.query(
          `insert into operations
             (id, owner_user_id, interview_id, idempotency_scope, idempotency_key, type,
              expected_version, input)
           values ('duplicate-idempotency-operation', 'aggregate-owner-a',
                   'aggregate-interview-a', 'answer', 'operation-a', 'submit_answer', 1, '{}')`,
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await pool.end();
    }
  });
});
