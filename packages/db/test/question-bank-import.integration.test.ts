import {
  KNOWLEDGE_DOMAINS,
  type KnowledgeDomain,
  normalizeQuestionBankSourcePath,
  parseAccountId,
  parseInterviewId,
  parseOperationId,
} from "@interview-agent/domain";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  InterviewCreationService,
  PgInterviewRepository,
  PgQuestionBankRepository,
  PgRepositoryUnitOfWork,
  QuestionBankImportService,
  QuestionBankVersionConflictError,
  questionBankSourceHash,
  questionBankVersions,
  RepositoryImmutableConflictError,
  sessionQuestionSnapshots,
  user,
} from "../src/index.js";
import type {
  QuestionBankImportEntry,
  QuestionBankImportRequest,
} from "../src/repositories/question-bank-repository.js";
import {
  databaseNow,
  type PostgresTestDatabase,
  PostgresTestHarness,
} from "./support/postgres-test-harness.js";
import { questionDefinitionFixture } from "./support/question-definition-fixture.js";

let harness: PostgresTestHarness;
let testDatabase: PostgresTestDatabase;
let service: QuestionBankImportService;
let creationService: InterviewCreationService;
let interviewRepository: PgInterviewRepository;

function entry(
  id: string,
  contentVersion: number,
  overrides: {
    readonly active?: boolean;
    readonly domain?: KnowledgeDomain;
    readonly sourceFile?: string;
    readonly sourceWording?: string;
  } = {},
): QuestionBankImportEntry {
  return {
    definition: questionDefinitionFixture({
      id,
      contentVersion,
      ...(overrides.domain === undefined ? {} : { domain: overrides.domain }),
      sourceWording:
        overrides.sourceWording ??
        `请解释 Go context 取消信号如何传播，以及调用方如何响应，版本 ${contentVersion}。`,
      active: overrides.active ?? true,
      reviewed: true,
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
    creationService = new InterviewCreationService(
      new PgRepositoryUnitOfWork(testDatabase.client.database),
    );
    interviewRepository = new PgInterviewRepository(testDatabase.client.database);
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

  it("creates complete snapshots that remain unchanged after importing later versions", async () => {
    const versionOneEntries = KNOWLEDGE_DOMAINS.map((domain, index) =>
      entry(`snapshot.${index + 1}`, 1, {
        domain,
        sourceWording: `请说明 ${domain} 的核心机制和工程取舍，版本 1。`,
      }),
    );
    await service.synchronize(request(versionOneEntries));
    await testDatabase.client.database.insert(user).values({
      id: "snapshot-owner",
      name: "Snapshot Owner",
      email: "snapshot-owner@example.com",
    });
    const occurredAt = await databaseNow(testDatabase);
    const transition = await creationService.create({
      accountId: parseAccountId("snapshot-owner"),
      interviewId: parseInterviewId("snapshot-interview"),
      operationId: parseOperationId("snapshot-create-operation"),
      questionCount: 5,
      occurredAt,
    });
    const originalBlueprint = transition.interview.blueprint.questions.map((item) => ({
      position: item.position,
      questionId: item.question.questionId,
      questionVersion: item.question.questionVersion,
      sourceWording: item.question.sourceWording,
      rubric: item.question.rubric,
      followUpGoals: item.question.followUpGoals,
      knowledgeExplanation: item.question.knowledgeExplanation,
    }));

    await service.synchronize(
      request(
        KNOWLEDGE_DOMAINS.map((domain, index) =>
          entry(`snapshot.${index + 1}`, 2, {
            domain,
            sourceWording: `请说明 ${domain} 的核心机制和工程取舍，版本 2。`,
          }),
        ),
      ),
    );
    const persisted = await interviewRepository.findById(
      parseInterviewId("snapshot-interview"),
      parseAccountId("snapshot-owner"),
    );
    const snapshots = await testDatabase.client.database
      .select()
      .from(sessionQuestionSnapshots)
      .where(eq(sessionQuestionSnapshots.interviewId, "snapshot-interview"))
      .orderBy(asc(sessionQuestionSnapshots.position));

    expect(snapshots).toHaveLength(5);
    expect(new Set(snapshots.map((snapshot) => snapshot.domain))).toHaveLength(5);
    expect(
      snapshots.map((snapshot) => ({
        position: snapshot.position,
        questionId: snapshot.sourceQuestionId,
        questionVersion: snapshot.sourceQuestionVersion,
        sourceWording: snapshot.sourceWording,
        rubric: snapshot.rubric,
        followUpGoals: snapshot.followUpGoals,
        knowledgeExplanation: snapshot.knowledgeExplanation,
      })),
    ).toEqual(originalBlueprint);
    expect(
      persisted?.blueprint.questions.map((item) => ({
        position: item.position,
        questionId: item.question.questionId,
        questionVersion: item.question.questionVersion,
        sourceWording: item.question.sourceWording,
        rubric: item.question.rubric,
        followUpGoals: item.question.followUpGoals,
        knowledgeExplanation: item.question.knowledgeExplanation,
      })),
    ).toEqual(originalBlueprint);
    expect(originalBlueprint.every((question) => question.questionVersion === 1)).toBe(true);
  });
});
