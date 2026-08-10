import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runQuestionBankImportCli } from "../../../scripts/import-question-bank.js";
import { mapQuestionBankQuestionDtoToDefinition } from "../../contracts/src/question-bank-mappings.js";
import {
  interviewSessions,
  normalizeQuestionBankSourcePath,
  PgQuestionBankRepository,
  QuestionBankImportService,
  QuestionBankValidationError,
  QuestionBankVersionConflictError,
  questionBankSourceHash,
  questionBankVersions,
  RepositoryCorruptionError,
  RepositoryImmutableConflictError,
  sessionQuestionSnapshots,
  user,
} from "../src/index.js";
import type {
  QuestionBankImportEntry,
  QuestionBankImportRequest,
} from "../src/repositories/question-bank-repository.js";
import { type PostgresTestDatabase, PostgresTestHarness } from "./support/postgres-test-harness.js";

const questionBankRoot = fileURLToPath(new URL("../../../question-bank", import.meta.url));
const REVIEWED_AT = "2026-08-10T00:00:00.000Z";

let harness: PostgresTestHarness;
let testDatabase: PostgresTestDatabase;
let service: QuestionBankImportService;

function entry(
  id: string,
  contentVersion: number,
  overrides: {
    readonly active?: boolean;
    readonly sourceFile?: string;
    readonly sourceWording?: string;
  } = {},
): QuestionBankImportEntry {
  return {
    definition: mapQuestionBankQuestionDtoToDefinition({
      id,
      contentVersion,
      domain: "go_language",
      difficulty: "medium",
      questionType: "conceptual",
      sourceWording:
        overrides.sourceWording ??
        `请解释 Go context 取消信号如何传播，以及调用方如何响应，版本 ${contentVersion}。`,
      rubric: [
        {
          id: "propagation",
          description: "说明取消信号沿派生 Context 传播",
          weight: 60,
        },
        {
          id: "cleanup",
          description: "说明调用方观察 Done 并释放资源",
          weight: 40,
        },
      ],
      followUpGoals: [
        {
          id: "clarify",
          kind: "clarification",
          goal: "澄清取消信号传播的调用链范围",
        },
        {
          id: "depth",
          kind: "depth",
          goal: "说明 goroutine 如何及时退出",
        },
      ],
      knowledgeExplanation: "Context 通过 Done 通道传播取消，相关 goroutine 应及时停止工作。",
      active: overrides.active ?? true,
      reviewed: true,
      reviewMetadata: {
        reviewedBy: "reviewer-id",
        reviewedAt: REVIEWED_AT,
        simplifiedChineseVerified: true,
        technicalTermsVerified: true,
      },
    }),
    schemaVersion: "1.0",
    sourceFile: overrides.sourceFile ?? "go_language/questions.yaml",
  };
}

function request(entries: readonly QuestionBankImportEntry[]): QuestionBankImportRequest {
  return {
    sourceName: "repository-question-bank",
    sourceVersion: 1,
    entries,
  };
}

async function rowsFor(questionId: string) {
  return testDatabase.client.database
    .select()
    .from(questionBankVersions)
    .where(eq(questionBankVersions.questionId, questionId))
    .orderBy(asc(questionBankVersions.contentVersion));
}

describe.sequential("question-bank PostgreSQL synchronization", () => {
  beforeAll(async () => {
    harness = await PostgresTestHarness.start();
    testDatabase = await harness.createDatabase({ name: "question_bank_import" });
    service = new QuestionBankImportService(
      new PgQuestionBankRepository(testDatabase.client.database),
    );
  }, 120_000);

  beforeEach(async () => {
    await testDatabase.pool.query(
      `truncate table "user", question_bank_versions restart identity cascade`,
    );
  });

  afterAll(async () => {
    await harness?.stop();
  });

  it("imports the first reviewed version with provenance and statement timestamp", async () => {
    const result = await service.synchronize(request([entry("go.sync.first", 1)]));
    const [row] = await rowsFor("go.sync.first");

    expect(result).toMatchObject({
      insertedCount: 1,
      noOpCount: 0,
      activatedCount: 1,
      retiredCount: 0,
    });
    expect(row).toMatchObject({
      questionId: "go.sync.first",
      contentVersion: 1,
      questionType: "conceptual",
      active: true,
      sourceActive: true,
      reviewed: true,
      reviewedBy: "reviewer-id",
      importSourceName: "repository-question-bank",
      importSourceVersion: 1,
      sourceSchemaVersion: "1.0",
      importSourceFile: "go_language/questions.yaml",
      importedAt: result.importedAt,
    });
    expect(row?.sourceHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("treats an identical reimport as an idempotent no-op", async () => {
    const first = await service.synchronize(request([entry("go.sync.idempotent", 1)]));
    const second = await service.synchronize(request([entry("go.sync.idempotent", 1)]));
    const [row] = await rowsFor("go.sync.idempotent");

    expect(second).toMatchObject({
      insertedCount: 0,
      noOpCount: 1,
      activatedCount: 0,
      retiredCount: 0,
    });
    expect(row?.importedAt).toEqual(first.importedAt);
  });

  it("normalizes Windows provenance before persistence and hashing", async () => {
    const windowsEntry = entry("go.sync.windows-path", 1, {
      sourceFile: "go_language\\questions.yaml",
    });
    const posixEntry = entry("go.sync.windows-path", 1, {
      sourceFile: "go_language/questions.yaml",
    });

    expect(normalizeQuestionBankSourcePath(windowsEntry.sourceFile)).toBe(
      "go_language/questions.yaml",
    );
    expect(questionBankSourceHash(request([windowsEntry]), windowsEntry)).toBe(
      questionBankSourceHash(request([posixEntry]), posixEntry),
    );
    await expect(service.synchronize(request([windowsEntry]))).resolves.toMatchObject({
      insertedCount: 1,
    });
    await expect(service.synchronize(request([posixEntry]))).resolves.toMatchObject({
      insertedCount: 0,
      noOpCount: 1,
    });
    expect((await rowsFor("go.sync.windows-path"))[0]?.importSourceFile).toBe(
      "go_language/questions.yaml",
    );
    expect(() => normalizeQuestionBankSourcePath("../outside.yaml")).toThrow(/escapes/u);
    expect(() => normalizeQuestionBankSourcePath("C:\\outside.yaml")).toThrow(/root-relative/u);
  });

  it("rejects immutable content differences for an existing identity", async () => {
    await service.synchronize(request([entry("go.sync.immutable", 1)]));

    await expect(
      service.synchronize(
        request([
          entry("go.sync.immutable", 1, {
            sourceWording: "请解释 Go context 取消传播，但这是被修改后的同版本题目。",
          }),
        ]),
      ),
    ).rejects.toBeInstanceOf(RepositoryImmutableConflictError);
    expect((await rowsFor("go.sync.immutable"))[0]?.sourceWording).toContain("调用方如何响应");
  });

  it("requires new versions to be monotonic while allowing gaps", async () => {
    await service.synchronize(request([entry("go.sync.monotonic", 2)]));

    await expect(
      service.synchronize(request([entry("go.sync.monotonic", 1)])),
    ).rejects.toBeInstanceOf(QuestionBankVersionConflictError);
    await expect(
      service.synchronize(request([entry("go.sync.monotonic", 4)])),
    ).resolves.toMatchObject({ insertedCount: 1, retiredCount: 1 });
    expect((await rowsFor("go.sync.monotonic")).map((row) => row.contentVersion)).toEqual([2, 4]);
  });

  it("activates only the latest imported version and retires its predecessor", async () => {
    await service.synchronize(request([entry("go.sync.active", 1)]));
    const result = await service.synchronize(request([entry("go.sync.active", 2)]));

    expect(result).toMatchObject({ activatedCount: 1, retiredCount: 1 });
    expect(
      (await rowsFor("go.sync.active")).map((row) => ({
        version: row.contentVersion,
        active: row.active,
        sourceActive: row.sourceActive,
      })),
    ).toEqual([
      { version: 1, active: false, sourceActive: true },
      { version: 2, active: true, sourceActive: true },
    ]);
  });

  it("uses a newer inactive version as an explicit tombstone", async () => {
    await service.synchronize(request([entry("go.sync.tombstone", 1)]));
    const result = await service.synchronize(
      request([entry("go.sync.tombstone", 2, { active: false })]),
    );

    expect(result).toMatchObject({ activatedCount: 0, retiredCount: 1 });
    expect((await rowsFor("go.sync.tombstone")).every((row) => !row.active)).toBe(true);
  });

  it("does not retire or delete questions omitted from a later source set", async () => {
    await service.synchronize(request([entry("go.sync.present", 1), entry("go.sync.removed", 1)]));
    await service.synchronize(request([entry("go.sync.present", 1)]));

    expect((await rowsFor("go.sync.removed"))[0]).toMatchObject({ active: true });
  });

  it("rolls back every insert when any version in the transaction conflicts", async () => {
    await service.synchronize(request([entry("go.sync.rollback-b", 2)]));

    await expect(
      service.synchronize(
        request([entry("go.sync.rollback-a", 1), entry("go.sync.rollback-b", 1)]),
      ),
    ).rejects.toBeInstanceOf(QuestionBankVersionConflictError);
    expect(await rowsFor("go.sync.rollback-a")).toEqual([]);
    expect((await rowsFor("go.sync.rollback-b")).map((row) => row.contentVersion)).toEqual([2]);
  });

  it("serializes concurrent imports without duplicate active versions", async () => {
    const concurrentRequest = request([entry("go.sync.concurrent", 1)]);
    const results = await Promise.all([
      service.synchronize(concurrentRequest),
      service.synchronize(concurrentRequest),
    ]);

    expect(results.map((result) => result.insertedCount).sort()).toEqual([0, 1]);
    expect(await rowsFor("go.sync.concurrent")).toHaveLength(1);
    expect((await rowsFor("go.sync.concurrent")).filter((row) => row.active)).toHaveLength(1);
  });

  it("keeps a v1 session snapshot unchanged after importing v2", async () => {
    await service.synchronize(request([entry("go.sync.snapshot", 1)]));
    await testDatabase.client.database.transaction(async (transaction) => {
      await transaction.insert(user).values({
        id: "snapshot-owner",
        name: "Snapshot Owner",
        email: "snapshot-owner@example.com",
      });
      await transaction.insert(interviewSessions).values({
        id: "snapshot-interview",
        ownerUserId: "snapshot-owner",
        selectedQuestionCount: 5,
        selectionSeed: "snapshot-seed",
      });
      await transaction.insert(sessionQuestionSnapshots).values(
        Array.from({ length: 5 }, (_, index) => ({
          id: `snapshot-${index + 1}`,
          interviewId: "snapshot-interview",
          position: index + 1,
          sourceQuestionId: "go.sync.snapshot",
          sourceQuestionVersion: 1,
          domain: "go_language" as const,
          sourceWording: "冻结的 v1 题目内容",
          displayWording: "冻结的 v1 题目内容",
          rubric: [],
          followUpGoals: [],
          knowledgeExplanation: "冻结的 v1 知识说明",
        })),
      );
    });

    await service.synchronize(request([entry("go.sync.snapshot", 2)]));
    const snapshots = await testDatabase.client.database
      .select()
      .from(sessionQuestionSnapshots)
      .where(eq(sessionQuestionSnapshots.interviewId, "snapshot-interview"))
      .orderBy(asc(sessionQuestionSnapshots.position));

    expect(snapshots).toHaveLength(5);
    expect(snapshots.every((snapshot) => snapshot.sourceQuestionVersion === 1)).toBe(true);
    expect(snapshots.every((snapshot) => snapshot.sourceWording === "冻结的 v1 题目内容")).toBe(
      true,
    );
  });

  it("runs the CLI against an empty development bank as a no-op", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runQuestionBankImportCli(["--root", resolve(questionBankRoot)], {
      environment: { DATABASE_URL: testDatabase.databaseUrl },
      io: {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
      },
    });

    expect(code).toBe(0);
    expect(stdout.join("\n")).toContain("0 inserted");
    expect(stderr).toEqual([]);
  });

  it("does not expose driver messages or query parameters from an unknown database error", async () => {
    const stderr: string[] = [];
    const sensitiveWording = "SECRET SOURCE WORDING";
    const sensitiveRubric = "SECRET RUBRIC";
    const code = await runQuestionBankImportCli(["--root", resolve(questionBankRoot)], {
      environment: { DATABASE_URL: "postgres://unused.example/interview" },
      importer: {
        synchronize: async () => {
          const error = new Error(
            `Failed query with params: ${sensitiveWording}; ${sensitiveRubric}`,
          ) as Error & { params: readonly string[] };
          error.params = [sensitiveWording, sensitiveRubric];
          throw error;
        },
      },
      io: {
        stdout: () => undefined,
        stderr: (message) => stderr.push(message),
      },
    });

    expect(code).toBe(1);
    expect(stderr).toEqual(["Question-bank import failed due to a database error."]);
    expect(stderr.join("\n")).not.toContain(sensitiveWording);
    expect(stderr.join("\n")).not.toContain(sensitiveRubric);
    expect(stderr.join("\n")).not.toContain("params");
  });

  it.each([
    [
      new QuestionBankValidationError("go.safe.validation", 2, "active_unreviewed"),
      "go.safe.validation@2 (question_bank_validation:active_unreviewed)",
    ],
    [
      new QuestionBankVersionConflictError("go.safe.version", 2, 3),
      "go.safe.version@2 (question_bank_version_conflict)",
    ],
    [
      new RepositoryImmutableConflictError("question-bank version", "go.safe.immutable@4"),
      "go.safe.immutable@4 (repository_immutable_conflict)",
    ],
    [
      new RepositoryCorruptionError(
        "question-bank version",
        "go.safe.corruption@5",
        "SECRET SOURCE WORDING AND RUBRIC",
      ),
      "go.safe.corruption@5 (repository_corruption)",
    ],
  ])("maps known repository errors to stable identity and code", async (error, expected) => {
    const stderr: string[] = [];
    const code = await runQuestionBankImportCli(["--root", resolve(questionBankRoot)], {
      environment: { DATABASE_URL: "postgres://unused.example/interview" },
      importer: {
        synchronize: async () => {
          throw error;
        },
      },
      io: {
        stdout: () => undefined,
        stderr: (message) => stderr.push(message),
      },
    });

    expect(code).toBe(1);
    expect(stderr).toEqual([`Question-bank import rejected ${expected}.`]);
    expect(stderr.join("\n")).not.toContain("SECRET");
    expect(stderr.join("\n")).not.toContain("Rubric");
  });
});
