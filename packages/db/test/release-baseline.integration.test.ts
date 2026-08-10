import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateDomainScores,
  completeInterviewOperation,
  handleInterviewCommand,
  type ImmutableReportSnapshot,
  type Interview,
  type InterviewBlueprint,
  type InterviewCommandResult,
  type InterviewOperationPlan,
  type InterviewTransition,
  type KnowledgeDomain,
  parseAccountId,
  parseAnswerMaterialId,
  parseEvaluationId,
  parseFollowUpGoalId,
  parseInterviewId,
  parseOperationId,
  parsePositiveQuestionScore,
  parseQuestionId,
  parseReportId,
  parseRubricItemId,
  validateImmutableReportSnapshot,
} from "@interview-agent/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type EvaluationPersistence,
  PgInterviewRepository,
  PgLifecycleRepository,
  PgOperationRepository,
  PgReportRepository,
  PgRepositoryUnitOfWork,
  questionBankVersions,
  type ReportPersistence,
  user,
} from "../src/index.js";
import { runDatabaseMigrations } from "../src/migrate.js";
import {
  type ExpectedPostgresCatalog,
  postgresCatalogHash,
  readPostgresCatalog,
} from "./support/postgres-catalog.js";
import {
  migrationHashes,
  type PostgresTestDatabase,
  PostgresTestHarness,
  readMigrationJournal,
} from "./support/postgres-test-harness.js";
import { questionBankFixtureSourceHash } from "./support/question-bank-fixture.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const migrationCli = resolve(packageRoot, "dist/cli/migrate.js");
const catalogSnapshotPath = resolve(packageRoot, "test/fixtures/postgres-catalog.snapshot.json");
const STARTED_AT = new Date("2026-08-10T08:00:00.000Z");
const ACCOUNT_ID = parseAccountId("release-baseline-owner");
const INTERVIEW_ID = parseInterviewId("release-baseline-interview");
const OPERATION_ID = parseOperationId("release-baseline-answer-operation");
const MATERIAL_ID = parseAnswerMaterialId("release-baseline-answer-material");
const DOMAINS: readonly KnowledgeDomain[] = [
  "go_language",
  "concurrency_runtime_performance",
  "http_rpc_api",
  "database_storage",
  "cache_messaging_distributed",
];
const TABLES = [
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
] as const;
const modelMetadata = {
  provider: "faux",
  modelId: "release-baseline",
  promptVersion: "prompt-1",
  schemaVersion: "schema-1",
  questionVersion: 1,
  purpose: "answer_evaluation",
  latencyMs: 1,
  inputTokens: 1,
  outputTokens: 1,
} as const;

let harness: PostgresTestHarness;
let primary: PostgresTestDatabase;

describe.sequential("clean PostgreSQL release integration baseline", () => {
  beforeAll(async () => {
    harness = await PostgresTestHarness.start();
    primary = await harness.createDatabase({ name: "release_baseline_primary" });
  }, 120_000);

  afterAll(async () => {
    await harness?.stop();
  });

  it("applies the ordered migration journal and installs the complete schema inventory", async () => {
    const expectedJournal = await readMigrationJournal();
    const expectedHashes = await migrationHashes();
    const expectedCatalog = JSON.parse(
      await readFile(catalogSnapshotPath, "utf8"),
    ) as ExpectedPostgresCatalog;
    const applied = await appliedMigrations(primary);

    expect(expectedJournal.map((entry) => entry.idx)).toEqual(
      expectedJournal.map((_, index) => index),
    );
    expect(applied).toEqual(
      expectedJournal.map((entry, index) => ({
        createdAt: String(entry.when),
        hash: required(expectedHashes[index]),
      })),
    );
    const catalog = await readPostgresCatalog(primary.pool);
    expect(catalog).toEqual(expectedCatalog.catalog);
    expect(postgresCatalogHash(catalog)).toBe(expectedCatalog.catalogHash);
  });

  it("is a no-op on repeat migration and succeeds through the production CLI", async () => {
    const before = await appliedMigrations(primary);
    await runDatabaseMigrations({ databaseUrl: primary.databaseUrl });
    expect(await appliedMigrations(primary)).toEqual(before);

    const result = await runProcess(process.execPath, [migrationCli], {
      ...process.env,
      DATABASE_URL: primary.databaseUrl,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Database migrations completed.");
    expect(await appliedMigrations(primary)).toEqual(before);
  });

  it("persists one representative aggregate, Operation, report, history, and deletion marker", async () => {
    const { client } = primary;
    const interviews = new PgInterviewRepository(client.database);
    const operations = new PgOperationRepository(client.database);
    const reports = new PgReportRepository(client.database);
    const lifecycle = new PgLifecycleRepository(client.database, undefined, {
      deletionRequestId: () => "release-baseline-deletion",
    });
    const unitOfWork = new PgRepositoryUnitOfWork(client.database);

    await client.database.insert(user).values({
      id: ACCOUNT_ID,
      name: "Release Baseline",
      email: "release-baseline@example.com",
    });
    await client.database.insert(questionBankVersions).values(
      blueprint().questions.map(({ question }) => ({
        questionId: question.questionId,
        contentVersion: question.questionVersion,
        domain: question.domain,
        sourceWording: question.sourceWording,
        rubric: question.rubric,
        followUpGoals: question.followUpGoals,
        knowledgeExplanation: question.knowledgeExplanation,
        active: true,
        sourceActive: true,
        reviewed: true,
        importSourceName: "release-baseline",
        importSourceVersion: 1,
        sourceHash: questionBankFixtureSourceHash(String(question.questionId)),
      })),
    );

    const created = expectTransition(
      handleInterviewCommand(null, {
        type: "create_interview",
        interviewId: INTERVIEW_ID,
        accountId: ACCOUNT_ID,
        operationId: parseOperationId("release-baseline-create"),
        expectedVersion: 0,
        occurredAt: STARTED_AT,
        questionCount: 5,
        blueprint: blueprint(),
      }),
    ).interview;
    await interviews.create(created);
    expect(await interviews.findById(INTERVIEW_ID, ACCOUNT_ID)).toEqual(created);

    const answerAt = new Date(STARTED_AT.getTime() + 1_000);
    const plan = expectPlan(
      handleInterviewCommand(created, {
        type: "submit_answer",
        interviewId: INTERVIEW_ID,
        operationId: OPERATION_ID,
        expectedVersion: created.version,
        occurredAt: answerAt,
        answerMaterialId: MATERIAL_ID,
        text: "A representative answer",
      }),
    );
    const claimed = await unitOfWork.run(async (repositories) => {
      await repositories.operations.createOrLoad({
        id: OPERATION_ID,
        accountId: ACCOUNT_ID,
        interviewId: INTERVIEW_ID,
        idempotencyScope: "interview-command",
        type: "submit_answer",
        idempotencyKey: "release-baseline-answer",
        expectedVersion: created.version,
        input: { questionPosition: 1, text: "A representative answer" },
        createdAt: answerAt,
      });
      const operation = await repositories.operations.claimPending({
        operationId: OPERATION_ID,
        accountId: ACCOUNT_ID,
        leaseOwner: "release-baseline-worker",
        leaseDurationMs: 60_000,
      });
      if (operation === null) {
        throw new Error("Expected the release baseline Operation to be claimable");
      }
      await repositories.interviews.save({
        previous: created,
        current: plan.interview,
        events: [],
      });
      return operation;
    });

    const evaluated = completeInterviewOperation(plan.interview, plan, {
      type: "record_question_evaluation",
      interviewId: INTERVIEW_ID,
      operationId: OPERATION_ID,
      expectedVersion: plan.interview.version,
      occurredAt: new Date(answerAt.getTime() + 1_000),
      evaluation: {
        id: parseEvaluationId("release-baseline-evaluation"),
        classification: "relevant",
        rubricItems: [
          {
            rubricItemId: parseRubricItemId("release-rubric-1"),
            evidenceMaterialIds: [MATERIAL_ID],
            awardedPoints: 100,
            missingOrIncorrectPoints: [],
          },
        ],
      },
    });
    const evaluationEvent = required(
      evaluated.events.find((event) => event.type === "question_evaluation_recorded"),
    );
    if (evaluationEvent.type !== "question_evaluation_recorded") {
      throw new Error("Expected a persisted evaluation event");
    }
    const evaluation: EvaluationPersistence = {
      evaluationId: evaluationEvent.evaluation.id,
      questionPosition: evaluationEvent.questionPosition,
      evaluation: evaluationEvent.evaluation,
      modelMetadata,
      createdAt: evaluationEvent.occurredAt,
    };
    await unitOfWork.run(async (repositories) => {
      await repositories.operations.completeSuccess({
        operationId: OPERATION_ID,
        accountId: ACCOUNT_ID,
        leaseOwner: claimed.leaseOwner,
        leaseToken: claimed.leaseToken,
        attemptCount: claimed.attemptCount,
        result: { accepted: true },
      });
      await repositories.interviews.save({
        previous: plan.interview,
        current: evaluated.interview,
        events: evaluated.events,
        evaluations: [evaluation],
      });
    });
    expect(await operations.findById(OPERATION_ID, ACCOUNT_ID)).toMatchObject({
      status: "succeeded",
      result: { accepted: true },
    });

    let interview = evaluated.interview;
    interview = await saveImmediate(interviews, interview, "continue_interview", 3_000);
    for (let position = 2; position <= 5; position += 1) {
      interview = await saveImmediate(
        interviews,
        interview,
        "mark_question_unknown",
        position * 2_000,
      );
      interview = await saveImmediate(
        interviews,
        interview,
        "continue_interview",
        position * 2_000 + 1_000,
      );
    }
    expect(interview.status).toBe("report_pending");

    const reportAt = new Date(STARTED_AT.getTime() + 20_000);
    const report = completeReport(interview, reportAt);
    expect(validateImmutableReportSnapshot(report.snapshot)).toEqual([]);
    const recorded = expectTransition(
      handleInterviewCommand(interview, {
        type: "record_report",
        interviewId: INTERVIEW_ID,
        operationId: parseOperationId("release-baseline-report-operation"),
        expectedVersion: interview.version,
        occurredAt: reportAt,
        reportId: report.id,
        reportKind: "complete",
      }),
    );
    await interviews.save({
      previous: interview,
      current: recorded.interview,
      events: recorded.events,
      report,
    });

    expect(await reports.findByInterviewId(INTERVIEW_ID, ACCOUNT_ID)).toMatchObject({
      id: report.id,
      kind: "complete",
    });
    expect(await interviews.listHistory(ACCOUNT_ID)).toEqual([
      expect.objectContaining({
        interviewId: INTERVIEW_ID,
        overallScore: 20,
        reportId: report.id,
        status: "completed",
      }),
    ]);

    await expect(lifecycle.markInterviewDeleting(INTERVIEW_ID, ACCOUNT_ID)).resolves.toMatchObject({
      created: true,
    });
    await expect(interviews.findById(INTERVIEW_ID, ACCOUNT_ID)).resolves.toBeNull();
    await expect(reports.findByInterviewId(INTERVIEW_ID, ACCOUNT_ID)).resolves.toBeNull();
    await expect(interviews.listHistory(ACCOUNT_ID)).resolves.toEqual([]);
  });

  it("starts a fresh second database with no state leaked from the first", async () => {
    const fresh = await harness.createDatabase({ name: "release_baseline_fresh" });
    try {
      expect(await appliedMigrations(fresh)).toHaveLength((await readMigrationJournal()).length);
      for (const table of TABLES) {
        const result = await fresh.pool.query<{ count: string }>(
          `select count(*)::text as count from "${table}"`,
        );
        expect(result.rows[0]?.count, table).toBe("0");
      }
    } finally {
      await harness.dropDatabase(fresh);
    }
  });
});

function blueprint(): InterviewBlueprint {
  return {
    selectionSeed: "release-baseline-seed",
    questions: DOMAINS.map((domain, index) => {
      const position = index + 1;
      return {
        position,
        question: {
          questionId: parseQuestionId(`release-question-${position}`),
          questionVersion: 1,
          domain,
          sourceWording: `Source question ${position}`,
          displayedWording: `Displayed question ${position}`,
          rubric: [
            {
              id: parseRubricItemId(`release-rubric-${position}`),
              description: `Required point ${position}`,
              weight: 100,
            },
          ],
          followUpGoals: [
            {
              id: parseFollowUpGoalId(`release-clarification-${position}`),
              kind: "clarification",
              goal: `Clarify answer ${position}`,
            },
            {
              id: parseFollowUpGoalId(`release-depth-${position}`),
              kind: "depth",
              goal: `Explore depth ${position}`,
            },
          ],
          knowledgeExplanation: `Internal explanation ${position}`,
        },
      };
    }),
  };
}

async function saveImmediate(
  repository: PgInterviewRepository,
  interview: Interview,
  command: "continue_interview" | "mark_question_unknown",
  offsetMs: number,
): Promise<Interview> {
  const transition = expectTransition(
    handleInterviewCommand(interview, {
      type: command,
      interviewId: interview.id,
      operationId: parseOperationId(`release-${command}-${interview.version}`),
      expectedVersion: interview.version,
      occurredAt: new Date(STARTED_AT.getTime() + offsetMs),
    }),
  );
  await repository.save({
    previous: interview,
    current: transition.interview,
    events: transition.events,
  });
  return transition.interview;
}

function completeReport(interview: Interview, createdAt: Date): ReportPersistence {
  const id = parseReportId("release-baseline-report");
  const questions = interview.questions.map((question) => {
    const source = required(interview.blueprint.questions[question.position - 1]).question;
    const outcome = required(question.outcome);
    const evidence = [{ source: "question_snapshot" as const, questionId: source.questionId }];
    return outcome.kind === "scored"
      ? {
          questionId: source.questionId,
          questionVersion: source.questionVersion,
          domain: source.domain,
          position: question.position,
          displayedQuestion: source.displayedWording,
          answerSummary: "Representative answer summary",
          outcome: "scored" as const,
          score: outcome.score,
          matchedKnowledgePoints: [
            {
              rubricItemId: required(source.rubric[0]).id,
              summary: "Required point was demonstrated",
              awardedPoints: outcome.score,
              evidence,
            },
          ],
          missingOrIncorrectPoints: [],
          scoreRationale: "The stored evidence satisfies the Rubric.",
          improvementSuggestions: ["Continue practicing concise explanations."],
          evidence,
        }
      : {
          questionId: source.questionId,
          questionVersion: source.questionVersion,
          domain: source.domain,
          position: question.position,
          displayedQuestion: source.displayedWording,
          answerSummary: "The question was marked unknown.",
          outcome: "unknown" as const,
          score: 0 as const,
          zeroScoreReason: "unknown" as const,
          matchedKnowledgePoints: [],
          missingOrIncorrectPoints: [
            {
              rubricItemId: required(source.rubric[0]).id,
              summary: "The required point was not assessed.",
              evidence,
            },
          ],
          scoreRationale: "Unknown answers receive zero points.",
          improvementSuggestions: ["Review the required point."],
          evidence,
        };
  });
  const reportMetadata = {
    ...modelMetadata,
    purpose: "report_analysis",
    questionVersion: null,
  };
  const snapshot: ImmutableReportSnapshot = {
    kind: "complete",
    reportId: id,
    interviewId: interview.id,
    accountId: interview.accountId,
    generatedAt: createdAt.toISOString(),
    overallExplanation: "Representative release-baseline report.",
    strengths: ["One complete answer"],
    weaknesses: ["Four unknown answers"],
    priorities: ["Broaden domain coverage"],
    learningSuggestions: ["Practice each assessed domain"],
    schemaVersion: "1.0",
    modelMetadata: {
      provider: reportMetadata.provider,
      modelId: reportMetadata.modelId,
      promptVersion: reportMetadata.promptVersion,
      schemaVersion: reportMetadata.schemaVersion,
      questionVersion: reportMetadata.questionVersion,
      purpose: reportMetadata.purpose,
      latencyMs: reportMetadata.latencyMs,
      tokens: {
        inputTokens: reportMetadata.inputTokens,
        outputTokens: reportMetadata.outputTokens,
      },
    },
    questionVersions: questions.map((question) => ({
      questionId: question.questionId,
      questionVersion: question.questionVersion,
    })),
    domains: aggregateDomainScores(
      questions.map((question) => ({
        domain: question.domain,
        outcome:
          question.outcome === "scored"
            ? { kind: "scored" as const, score: parsePositiveQuestionScore(question.score) }
            : {
                kind: "unknown" as const,
                score: 0 as const,
                zeroScoreReason: "unknown" as const,
              },
      })),
    ),
    questions,
    overallScore: 20,
  };
  return {
    id,
    kind: "complete",
    schemaVersion: "1.0",
    snapshot,
    modelMetadata: reportMetadata,
    createdAt,
  };
}

function expectTransition(result: InterviewCommandResult): InterviewTransition {
  if (result.kind !== "transition") {
    throw new Error("Expected an immediate interview transition");
  }
  return result;
}

function expectPlan(result: InterviewCommandResult): InterviewOperationPlan {
  if (result.kind !== "operation_plan") {
    throw new Error("Expected an interview Operation plan");
  }
  return result;
}

async function appliedMigrations(database: PostgresTestDatabase) {
  const result = await database.pool.query<{ createdAt: string; hash: string }>(
    `select created_at::text as "createdAt", hash
       from drizzle.__drizzle_migrations
      order by created_at`,
  );
  return result.rows;
}

function runProcess(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ readonly exitCode: number | null; readonly stderr: string; readonly stdout: string }> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, {
      cwd: packageRoot,
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
    child.on("close", (exitCode) => resolveProcess({ exitCode, stderr, stdout }));
  });
}

function required<Value>(value: Value | null | undefined): Value {
  if (value === null || value === undefined) {
    throw new Error("Expected value to be present");
  }
  return value;
}
