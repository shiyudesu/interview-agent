import {
  parseAccountId,
  parseFollowUpGoalId,
  parseInterviewId,
  parseQuestionId,
  parseRubricItemId,
} from "@interview-agent/domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  BlueprintSelectionInputService,
  deletionRequests,
  interviewSessions,
  PgQuestionBankRepository,
  questionBankSourceHash,
  questionBankVersions,
  RepositoryCorruptionError,
  selectionSeedForInterview,
  sessionQuestionSnapshots,
  user,
} from "../src/index.js";
import { type PostgresTestDatabase, PostgresTestHarness } from "./support/postgres-test-harness.js";

let harness: PostgresTestHarness;
let testDatabase: PostgresTestDatabase;
let repository: PgQuestionBankRepository;

const RUBRIC = [
  {
    id: parseRubricItemId("selection.rubric"),
    description: "Required point",
    weight: 100,
  },
];
const FOLLOW_UP_GOALS = [
  {
    id: parseFollowUpGoalId("selection.clarification"),
    kind: "clarification" as const,
    goal: "Clarify the required point",
  },
];

async function seedOwner(ownerId = "selection-owner"): Promise<void> {
  await testDatabase.client.database.insert(user).values({
    id: ownerId,
    name: "Selection Owner",
    email: `${ownerId}@example.com`,
  });
}

async function seedBankQuestion(
  questionId: string,
  contentVersion = 1,
  overrides: {
    readonly active?: boolean;
    readonly reviewed?: boolean;
    readonly sourceActive?: boolean;
  } = {},
): Promise<void> {
  const active = overrides.active ?? true;
  const reviewed = overrides.reviewed ?? true;
  const sourceActive = overrides.sourceActive ?? active;
  const definition = {
    questionId: parseQuestionId(questionId),
    questionVersion: contentVersion,
    domain: "go_language" as const,
    difficulty: "medium" as const,
    questionType: "conceptual" as const,
    sourceWording: `Source wording for ${questionId} v${contentVersion}`,
    rubric: RUBRIC,
    followUpGoals: FOLLOW_UP_GOALS,
    knowledgeExplanation: `Knowledge explanation for ${questionId}`,
    active: sourceActive,
    reviewed,
    reviewMetadata: reviewed
      ? {
          reviewedBy: "reviewer",
          reviewedAt: new Date("2026-08-10T00:00:00.000Z"),
          simplifiedChineseVerified: true as const,
          technicalTermsVerified: true as const,
        }
      : null,
  };
  const entry = {
    definition,
    schemaVersion: "1.0",
    sourceFile: "selection/questions.yaml",
  };
  const request = {
    sourceName: "selection-test",
    sourceVersion: 1,
    entries: [entry],
  };
  await testDatabase.client.database.insert(questionBankVersions).values({
    questionId,
    contentVersion,
    domain: definition.domain,
    difficulty: definition.difficulty,
    questionType: definition.questionType,
    sourceWording: definition.sourceWording,
    rubric: RUBRIC,
    followUpGoals: FOLLOW_UP_GOALS,
    knowledgeExplanation: definition.knowledgeExplanation,
    active,
    sourceActive,
    reviewed,
    reviewedAt: definition.reviewMetadata?.reviewedAt ?? null,
    reviewedBy: definition.reviewMetadata?.reviewedBy ?? null,
    importSourceName: request.sourceName,
    importSourceVersion: request.sourceVersion,
    sourceSchemaVersion: entry.schemaVersion,
    importSourceFile: entry.sourceFile,
    sourceHash: questionBankSourceHash(request, entry),
  });
}

async function seedTerminalInterview(input: {
  readonly id: string;
  readonly endedAt: Date;
  readonly questionIds: readonly string[];
  readonly status?: "abandoned" | "active" | "completed" | "deleting" | "early_ended";
  readonly deletionRequestedAt?: Date;
}): Promise<void> {
  const firstQuestionId = input.questionIds[0];
  if (firstQuestionId === undefined) {
    throw new Error("Interview fixture requires at least one question ID");
  }
  await testDatabase.client.database.transaction(async (transaction) => {
    await transaction.insert(interviewSessions).values({
      id: input.id,
      ownerUserId: "selection-owner",
      selectedQuestionCount: 5,
      selectionSeed: `${input.id}-seed`,
    });
    await transaction.insert(sessionQuestionSnapshots).values(
      Array.from({ length: 5 }, (_, index) => input.questionIds[index] ?? firstQuestionId).map(
        (questionId, index) => ({
          id: `${input.id}:snapshot:${index + 1}`,
          interviewId: input.id,
          position: index + 1,
          sourceQuestionId: questionId,
          sourceQuestionVersion: 1,
          domain: "go_language" as const,
          sourceWording: `Frozen ${questionId}`,
          displayWording: `Frozen ${questionId}`,
          rubric: RUBRIC,
          followUpGoals: FOLLOW_UP_GOALS,
          knowledgeExplanation: `Frozen explanation ${questionId}`,
        }),
      ),
    );
    const status = input.status ?? "completed";
    if (status !== "active") {
      await transaction
        .update(interviewSessions)
        .set({
          status,
          activePhase: null,
          endedAt: input.endedAt,
          deletionRequestedAt: input.deletionRequestedAt ?? null,
        })
        .where(eq(interviewSessions.id, input.id));
    }
  });
}

describe.sequential("blueprint selection PostgreSQL inputs", () => {
  beforeAll(async () => {
    harness = await PostgresTestHarness.start();
    testDatabase = await harness.createDatabase({ name: "blueprint_selection" });
    repository = new PgQuestionBankRepository(testDatabase.client.database);
  }, 120_000);

  beforeEach(async () => {
    await testDatabase.pool.query(
      `truncate table deletion_requests, "user", question_bank_versions restart identity cascade`,
    );
  });

  afterAll(async () => {
    await harness?.stop();
  });

  it("loads only eligible current versions and derives the persisted seed from the interview ID", async () => {
    await seedOwner();
    await seedBankQuestion("eligible.stable", 1, {
      active: false,
      sourceActive: true,
    });
    await seedBankQuestion("eligible.stable", 2);
    await seedBankQuestion("retired.question", 1, {
      active: false,
      sourceActive: true,
    });
    await seedBankQuestion("unreviewed.question", 1, {
      active: false,
      reviewed: false,
      sourceActive: true,
    });

    const interviewId = parseInterviewId("selection-interview");
    const service = new BlueprintSelectionInputService(repository);
    const input = await service.load({
      accountId: parseAccountId("selection-owner"),
      interviewId,
      questionCount: 5,
    });

    expect(input.selectionSeed).toBe(selectionSeedForInterview(interviewId));
    expect(input.recentQuestionIds.size).toBe(0);
    expect(input.eligibleQuestions).toEqual([
      expect.objectContaining({
        questionId: "eligible.stable",
        questionVersion: 2,
        displayedWording: "Source wording for eligible.stable v2",
      }),
    ]);
    await expect(repository.findQuestion(parseQuestionId("eligible.stable"), 1)).resolves.toEqual(
      expect.objectContaining({
        questionId: "eligible.stable",
        questionVersion: 1,
      }),
    );
    await expect(
      repository.findQuestion(parseQuestionId("missing.question"), 1),
    ).resolves.toBeNull();
  });

  it("rejects corrupted eligible question structures instead of returning partial snapshots", async () => {
    await seedOwner();
    await seedBankQuestion("corrupt.structure");
    await testDatabase.client.database
      .update(questionBankVersions)
      .set({ rubric: [] })
      .where(eq(questionBankVersions.questionId, "corrupt.structure"));

    await expect(repository.listEligibleQuestions()).rejects.toBeInstanceOf(
      RepositoryCorruptionError,
    );
  });

  it("collects questions from the three newest visible terminal interviews only", async () => {
    await seedOwner();
    const allQuestionIds = [
      "newest.1",
      "newest.2",
      "second.only",
      "third.only",
      "shared.recent",
      "fourth.excluded",
      "active.excluded",
      "deleting.excluded",
      "marked.excluded",
      "inaccessible.excluded",
    ];
    for (const questionId of allQuestionIds) {
      await seedBankQuestion(questionId);
    }

    const base = Date.parse("2026-08-10T00:00:00.000Z");
    await seedTerminalInterview({
      id: "visible-fourth",
      endedAt: new Date(base + 1_000),
      questionIds: ["fourth.excluded"],
    });
    await seedTerminalInterview({
      id: "visible-third",
      endedAt: new Date(base + 2_000),
      questionIds: ["third.only", "shared.recent"],
      status: "abandoned",
    });
    await seedTerminalInterview({
      id: "visible-second",
      endedAt: new Date(base + 3_000),
      questionIds: ["second.only", "shared.recent"],
      status: "early_ended",
    });
    await seedTerminalInterview({
      id: "visible-newest",
      endedAt: new Date(base + 4_000),
      questionIds: ["newest.1", "newest.2"],
    });
    await seedTerminalInterview({
      id: "deleting-newer",
      endedAt: new Date(base + 6_000),
      questionIds: ["deleting.excluded"],
      status: "deleting",
      deletionRequestedAt: new Date(base + 6_000),
    });
    await seedTerminalInterview({
      id: "marked-newer",
      endedAt: new Date(base + 7_000),
      questionIds: ["marked.excluded"],
      deletionRequestedAt: new Date(base + 7_000),
    });
    await seedTerminalInterview({
      id: "inaccessible-newer",
      endedAt: new Date(base + 8_000),
      questionIds: ["inaccessible.excluded"],
    });
    const requestedAt = new Date(base + 8_000);
    await testDatabase.client.database.insert(deletionRequests).values({
      id: "inaccessible-request",
      ownerUserId: "selection-owner",
      scope: "interview",
      interviewId: "inaccessible-newer",
      requestedAt,
      inaccessibleAt: requestedAt,
      purgeDueAt: requestedAt,
      purgeDeadlineAt: new Date(requestedAt.getTime() + 7 * 24 * 60 * 60 * 1_000),
    });
    await seedTerminalInterview({
      id: "active-newer",
      endedAt: new Date(base + 9_000),
      questionIds: ["active.excluded"],
      status: "active",
    });

    const recent = await repository.findRecentQuestionIds(parseAccountId("selection-owner"), 3);

    expect([...recent].sort()).toEqual(
      ["newest.1", "newest.2", "second.only", "shared.recent", "third.only"].sort(),
    );
    for (const excluded of [
      "fourth.excluded",
      "active.excluded",
      "deleting.excluded",
      "marked.excluded",
      "inaccessible.excluded",
    ]) {
      expect(recent.has(parseQuestionId(excluded))).toBe(false);
    }
  });
});
