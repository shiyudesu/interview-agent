import {
  type AccountId,
  aggregateDomainScores,
  cancelInterviewOperation,
  completeInterviewOperation,
  handleInterviewCommand,
  type ImmutableReportSnapshot,
  type Interview,
  type InterviewBlueprint,
  type InterviewCommandResult,
  type InterviewOperationPlan,
  type InterviewQuestionCount,
  type InterviewTransition,
  type KnowledgeDomain,
  type ModelCallMetadata,
  type OperationId,
  parseAccountId,
  parseAnswerMaterialId,
  parseEvaluationId,
  parseFollowUpGoalId,
  parseInterviewId,
  parseMessageId,
  parseOperationId,
  parsePositiveQuestionScore,
  parseQuestionId,
  parseReportId,
  parseRubricItemId,
} from "@interview-agent/domain";
import { and, eq } from "drizzle-orm";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createDatabaseClient,
  type DatabaseClient,
  type EvaluationPersistence,
  interviewSessions,
  type JsonObject,
  PgInterviewRepository,
  PgOperationRepository,
  PgReportRepository,
  PgRepositoryUnitOfWork,
  questionBankVersions,
  type ReportPersistence,
  RepositoryCorruptionError,
  RepositoryImmutableConflictError,
  RepositoryNotFoundError,
  type RepositoryVersionConflictError,
  reports,
  sessionQuestionSnapshots,
  user,
  withTransaction,
} from "../src/index.js";
import { runDatabaseMigrations } from "../src/migrate.js";

const STARTED_AT = new Date("2026-08-01T00:00:00.000Z");
const DOMAINS: readonly KnowledgeDomain[] = [
  "go_language",
  "concurrency_runtime_performance",
  "http_rpc_api",
  "database_storage",
  "cache_messaging_distributed",
];
const metadata: ModelCallMetadata = {
  provider: "faux",
  modelId: "faux-model",
  promptVersion: "prompt-1",
  schemaVersion: "schema-1",
  questionVersion: 1,
  purpose: "answer_evaluation",
  latencyMs: 5,
  inputTokens: 10,
  outputTokens: 5,
};

let container: StartedTestContainer;
let client: DatabaseClient;
let databaseUrl: string;
let interviewRepository: PgInterviewRepository;
let operationRepository: PgOperationRepository;
let reportRepository: PgReportRepository;
let unitOfWork: PgRepositoryUnitOfWork;
let operationSequence = 0;
const operationLeases = new Map<
  string,
  { readonly attemptCount: number; readonly leaseOwner: string; readonly leaseToken: string }
>();

function nextOperationId(prefix = "operation") {
  operationSequence += 1;
  return parseOperationId(`${prefix}-${operationSequence}`);
}

async function claimOperationForTest(
  repository: PgOperationRepository,
  operationId: OperationId,
  accountId: AccountId,
  _claimedAt: Date,
): Promise<void> {
  const claimed = await repository.claimPending({
    operationId,
    accountId,
    leaseOwner: `test-worker-${operationId}`,
    leaseDurationMs: 60_000,
  });
  if (claimed === null) {
    throw new Error(`Operation ${operationId} was not claimable`);
  }
  operationLeases.set(operationId, {
    leaseOwner: claimed.leaseOwner,
    leaseToken: claimed.leaseToken,
    attemptCount: claimed.attemptCount,
  });
}

async function finishOperation(
  repository: PgOperationRepository,
  update:
    | {
        readonly operationId: OperationId;
        readonly accountId: AccountId;
        readonly expectedStatus: "pending" | "processing";
        readonly status: "succeeded";
        readonly result: JsonObject;
        readonly completedAt: Date;
      }
    | {
        readonly operationId: OperationId;
        readonly accountId: AccountId;
        readonly expectedStatus: "pending" | "processing";
        readonly status: "failed";
        readonly error: JsonObject;
        readonly completedAt: Date;
      },
): Promise<void> {
  let lease = operationLeases.get(update.operationId);
  if (lease === undefined) {
    await claimOperationForTest(
      repository,
      update.operationId,
      update.accountId,
      new Date(update.completedAt.getTime() - 1),
    );
    lease = required(operationLeases.get(update.operationId));
  }
  if (update.status === "succeeded") {
    await repository.completeSuccess({
      operationId: update.operationId,
      accountId: update.accountId,
      ...lease,
      result: update.result,
    });
    return;
  }
  await repository.completeFailure({
    operationId: update.operationId,
    accountId: update.accountId,
    ...lease,
    error: update.error,
    retryable: false,
  });
}

async function createOperationForTest(
  repository: PgOperationRepository,
  operation: Omit<Parameters<PgOperationRepository["create"]>[0], "idempotencyScope"> & {
    readonly idempotencyScope?: string;
  },
) {
  return repository.create({
    ...operation,
    idempotencyScope: operation.idempotencyScope ?? "interview-command",
  });
}

function blueprint(prefix: string, questionCount: InterviewQuestionCount = 5): InterviewBlueprint {
  return {
    selectionSeed: `${prefix}-seed`,
    questions: Array.from({ length: questionCount }, (_, index) => {
      const position = index + 1;
      return {
        position,
        question: {
          questionId: parseQuestionId(`bank-question-${position}`),
          questionVersion: 1,
          domain: required(DOMAINS[index]),
          sourceWording: `Source question ${position}`,
          displayedWording: `Displayed question ${position}`,
          rubric: [
            {
              id: parseRubricItemId(`rubric-${position}`),
              description: "Required point",
              weight: 100,
            },
          ],
          followUpGoals: [
            {
              id: parseFollowUpGoalId(`clarification-${position}`),
              kind: "clarification",
              goal: "Clarify the answer",
            },
            {
              id: parseFollowUpGoalId(`depth-${position}`),
              kind: "depth",
              goal: "Explore depth",
            },
          ],
          knowledgeExplanation: "Internal explanation",
        },
      };
    }),
  };
}

function expectTransition(result: InterviewCommandResult): InterviewTransition {
  if (result.kind !== "transition") {
    throw new Error("Expected transition");
  }
  return result;
}

function expectPlan(result: InterviewCommandResult): InterviewOperationPlan {
  if (result.kind !== "operation_plan") {
    throw new Error("Expected Operation plan");
  }
  return result;
}

async function seedOwner(id: string): Promise<void> {
  await client.database.insert(user).values({
    id,
    name: id,
    email: `${id}@example.com`,
  });
}

async function seedQuestionBank(): Promise<void> {
  await client.database.insert(questionBankVersions).values(
    Array.from({ length: 5 }, (_, index) => {
      const position = index + 1;
      return {
        questionId: `bank-question-${position}`,
        contentVersion: 1,
        domain: required(DOMAINS[index]),
        sourceWording: `Source question ${position}`,
        rubric: [
          {
            id: parseRubricItemId(`rubric-${position}`),
            description: "Required point",
            weight: 100,
          },
        ],
        followUpGoals: [
          {
            id: parseFollowUpGoalId(`clarification-${position}`),
            kind: "clarification" as const,
            goal: "Clarify the answer",
          },
          {
            id: parseFollowUpGoalId(`depth-${position}`),
            kind: "depth" as const,
            goal: "Explore depth",
          },
        ],
        knowledgeExplanation: "Internal explanation",
        active: true,
        reviewed: true,
        importSourceName: "repository-fixture",
        importSourceVersion: 1,
      };
    }),
  );
}

async function createInterview(input: {
  readonly ownerId: string;
  readonly interviewId: string;
  readonly occurredAt?: Date;
  readonly blueprint?: InterviewBlueprint;
}): Promise<Interview> {
  const ownerId = parseAccountId(input.ownerId);
  const interviewId = parseInterviewId(input.interviewId);
  const result = expectTransition(
    handleInterviewCommand(null, {
      type: "create_interview",
      interviewId,
      accountId: ownerId,
      operationId: nextOperationId("create"),
      expectedVersion: 0,
      occurredAt: input.occurredAt ?? STARTED_AT,
      questionCount: 5,
      blueprint: input.blueprint ?? blueprint(input.interviewId),
    }),
  );
  await interviewRepository.create(result.interview);
  return result.interview;
}

async function saveAcceptedOperation(
  previous: Interview,
  plan: InterviewOperationPlan,
): Promise<void> {
  await unitOfWork.run(async (repositories) => {
    await claimOperationForTest(
      repositories.operations,
      plan.operationId,
      previous.accountId,
      plan.acceptedAt,
    );
    await repositories.interviews.save({
      previous,
      current: plan.interview,
      events: [],
    });
  });
}

async function saveSuccessfulCompletion(input: {
  readonly previous: Interview;
  readonly current: Interview;
  readonly events: InterviewTransition["events"];
  readonly evaluations?: readonly EvaluationPersistence[];
}): Promise<void> {
  const completedAt = required(input.events.at(-1)).occurredAt;
  await unitOfWork.run(async (repositories) => {
    await finishOperation(repositories.operations, {
      operationId: required(input.previous.pendingOperation).operationId,
      accountId: input.previous.accountId,
      expectedStatus: "processing",
      status: "succeeded",
      result: { accepted: true },
      completedAt,
    });
    await repositories.interviews.save({
      previous: input.previous,
      current: input.current,
      events: input.events,
      evaluations: input.evaluations,
    });
  });
}

async function saveImmediate(
  interview: Interview,
  command:
    | "mark_question_unknown"
    | "continue_interview"
    | "end_interview_early"
    | "abandon_interview",
  occurredAt: Date,
): Promise<Interview> {
  const transition = expectTransition(
    handleInterviewCommand(interview, {
      type: command,
      interviewId: interview.id,
      operationId: nextOperationId(command),
      expectedVersion: interview.version,
      occurredAt,
    }),
  );
  await interviewRepository.save({
    previous: interview,
    current: transition.interview,
    events: transition.events,
  });
  return transition.interview;
}

function reportPersistence(
  interview: Interview,
  kind: "complete" | "incomplete",
  reportIdValue: string,
  createdAt: Date,
  overallScore = 0,
): ReportPersistence {
  const reportId = parseReportId(reportIdValue);
  const reportMetadata = {
    ...metadata,
    purpose: "report_analysis",
    questionVersion: null,
  };
  const reportQuestions = interview.questions
    .filter((question) => kind === "complete" || question.outcome !== null)
    .map((question) => {
      const snapshot = required(interview.blueprint.questions[question.position - 1]).question;
      const outcome = required(question.outcome);
      const evidence = [{ source: "question_snapshot" as const, questionId: snapshot.questionId }];
      return outcome.kind === "scored"
        ? {
            questionId: snapshot.questionId,
            questionVersion: snapshot.questionVersion,
            domain: snapshot.domain,
            position: question.position,
            displayedQuestion: snapshot.displayedWording,
            answerSummary: "Answer summary",
            outcome: "scored" as const,
            score: outcome.score,
            matchedKnowledgePoints: required(question.evaluation)
              .rubricItems.filter((item) => item.awardedPoints > 0)
              .map((item) => ({
                rubricItemId: item.rubricItemId,
                summary: "Matched knowledge point",
                awardedPoints: item.awardedPoints,
                evidence,
              })),
            missingOrIncorrectPoints: required(question.evaluation).rubricItems.flatMap((item) =>
              item.missingOrIncorrectPoints.map((summary) => ({
                rubricItemId: item.rubricItemId,
                summary,
                evidence,
              })),
            ),
            scoreRationale: "Score rationale",
            improvementSuggestions: ["Improvement suggestion"],
            evidence,
          }
        : {
            questionId: snapshot.questionId,
            questionVersion: snapshot.questionVersion,
            domain: snapshot.domain,
            position: question.position,
            displayedQuestion: snapshot.displayedWording,
            answerSummary: "No correct answer material was available",
            outcome: outcome.kind,
            score: 0 as const,
            zeroScoreReason: outcome.zeroScoreReason,
            matchedKnowledgePoints: [],
            missingOrIncorrectPoints: [
              {
                rubricItemId: required(snapshot.rubric[0]).id,
                summary: "Required knowledge point was missing",
                evidence,
              },
            ],
            scoreRationale: "No points were awarded",
            improvementSuggestions: ["Review the required knowledge point"],
            evidence,
          };
    });
  const common = {
    reportId,
    interviewId: interview.id,
    accountId: interview.accountId,
    generatedAt: createdAt.toISOString(),
    overallExplanation: "Overall explanation",
    strengths: ["A recorded strength"],
    weaknesses: ["A recorded weakness"],
    priorities: ["A prioritized improvement"],
    learningSuggestions: ["A learning suggestion"],
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
    questionVersions: reportQuestions.map((question) => ({
      questionId: question.questionId,
      questionVersion: question.questionVersion,
    })),
    domains: aggregateDomainScores(
      reportQuestions.map((question) => ({
        domain: question.domain,
        outcome:
          question.outcome === "scored"
            ? { kind: "scored" as const, score: parsePositiveQuestionScore(question.score) }
            : {
                kind: question.outcome,
                score: 0 as const,
                zeroScoreReason: question.zeroScoreReason,
              },
      })),
    ),
    questions: reportQuestions,
  };
  const snapshot: ImmutableReportSnapshot =
    kind === "complete" ? { kind, ...common, overallScore } : { kind, ...common };
  return {
    id: reportId,
    kind,
    schemaVersion: "1.0",
    snapshot,
    modelMetadata: reportMetadata,
    createdAt,
  };
}

async function finishReport(
  interview: Interview,
  reportIdValue: string,
  occurredAt: Date,
  overallScore = 0,
): Promise<Interview> {
  if (interview.pendingReportKind === null) {
    throw new Error("Expected report-pending interview");
  }
  const transition = expectTransition(
    handleInterviewCommand(interview, {
      type: "record_report",
      interviewId: interview.id,
      operationId: nextOperationId("report"),
      expectedVersion: interview.version,
      occurredAt,
      reportId: parseReportId(reportIdValue),
      reportKind: interview.pendingReportKind,
    }),
  );
  await interviewRepository.save({
    previous: interview,
    current: transition.interview,
    events: transition.events,
    report: reportPersistence(
      interview,
      interview.pendingReportKind,
      reportIdValue,
      occurredAt,
      overallScore,
    ),
  });
  return transition.interview;
}

async function completeWithZeroScores(
  interview: Interview,
  firstActivityAt: Date,
): Promise<Interview> {
  let current = interview;
  for (let position = 1; position <= current.questionCount; position += 1) {
    current = await saveImmediate(
      current,
      "mark_question_unknown",
      new Date(firstActivityAt.getTime() + position * 2_000),
    );
    current = await saveImmediate(
      current,
      "continue_interview",
      new Date(firstActivityAt.getTime() + position * 2_000 + 1_000),
    );
  }
  return current;
}

describe.sequential("PostgreSQL repositories", () => {
  beforeAll(async () => {
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
    const database = new URL("postgresql://localhost/interview");
    database.hostname = container.getHost();
    database.port = String(container.getMappedPort(5432));
    database.username = "interview";
    database.password = "interview";
    databaseUrl = database.toString();
    await runDatabaseMigrations({ databaseUrl });
    client = createDatabaseClient({ databaseUrl, max: 5 });
    interviewRepository = new PgInterviewRepository(client.database);
    operationRepository = new PgOperationRepository(client.database);
    reportRepository = new PgReportRepository(client.database);
    unitOfWork = new PgRepositoryUnitOfWork(client.database);
  }, 120_000);

  beforeEach(async () => {
    operationLeases.clear();
    await client.pool.query(
      `truncate table "user", question_bank_versions restart identity cascade`,
    );
    await seedQuestionBank();
  });

  afterAll(async () => {
    await client?.close();
    await container?.stop();
  });

  it("creates and loads an exact aggregate roundtrip", async () => {
    await seedOwner("roundtrip-owner");
    const created = await createInterview({
      ownerId: "roundtrip-owner",
      interviewId: "roundtrip-interview",
    });

    await expect(interviewRepository.findById(created.id)).resolves.toEqual(created);
    await expect(interviewRepository.findActiveByAccountId(created.accountId)).resolves.toEqual(
      created,
    );
  });

  it("persists accepted processing, cancellation, messages, evaluation clearing, and replacement", async () => {
    await seedOwner("processing-owner");
    let interview = await createInterview({
      ownerId: "processing-owner",
      interviewId: "processing-interview",
    });

    const cancelledOperationId = nextOperationId("cancelled-answer");
    await createOperationForTest(operationRepository, {
      id: cancelledOperationId,
      accountId: interview.accountId,
      interviewId: interview.id,
      type: "submit_answer",
      idempotencyKey: "cancelled-answer",
      expectedVersion: interview.version,
      input: { questionPosition: 1, text: "cancel me" },
      createdAt: new Date(STARTED_AT.getTime() + 1_000),
    });
    const cancelledPlan = expectPlan(
      handleInterviewCommand(interview, {
        type: "submit_answer",
        interviewId: interview.id,
        operationId: cancelledOperationId,
        expectedVersion: interview.version,
        occurredAt: new Date(STARTED_AT.getTime() + 1_000),
        answerMaterialId: parseAnswerMaterialId("cancelled-material"),
        text: "cancel me",
      }),
    );
    await saveAcceptedOperation(interview, cancelledPlan);
    interview = required(await interviewRepository.findById(interview.id));
    expect(interview.phase).toBe("processing");
    expect(interview.pendingOperation?.operationId).toBe(cancelledOperationId);

    const cancelled = cancelInterviewOperation(interview, cancelledPlan);
    await unitOfWork.run(async (repositories) => {
      await finishOperation(repositories.operations, {
        operationId: cancelledOperationId,
        accountId: interview.accountId,
        expectedStatus: "processing",
        status: "failed",
        error: { code: "cancelled" },
        completedAt: new Date(STARTED_AT.getTime() + 1_500),
      });
      await repositories.interviews.save({
        previous: interview,
        current: cancelled,
        events: [],
      });
    });
    interview = required(await interviewRepository.findById(interview.id));
    expect(interview.phase).toBe("awaiting_response");
    expect(interview.pendingOperation).toBeNull();

    const answerOperationId = nextOperationId("answer");
    await createOperationForTest(operationRepository, {
      id: answerOperationId,
      accountId: interview.accountId,
      interviewId: interview.id,
      type: "submit_answer",
      idempotencyKey: "answer",
      expectedVersion: interview.version,
      input: { questionPosition: 1, text: "good answer" },
      createdAt: new Date(STARTED_AT.getTime() + 2_000),
    });
    const answerPlan = expectPlan(
      handleInterviewCommand(interview, {
        type: "submit_answer",
        interviewId: interview.id,
        operationId: answerOperationId,
        expectedVersion: interview.version,
        occurredAt: new Date(STARTED_AT.getTime() + 2_000),
        answerMaterialId: parseAnswerMaterialId("material-main"),
        text: "good answer",
      }),
    );
    await saveAcceptedOperation(interview, answerPlan);
    interview = answerPlan.interview;
    const evaluated = completeInterviewOperation(interview, answerPlan, {
      type: "record_question_evaluation",
      interviewId: interview.id,
      operationId: answerOperationId,
      expectedVersion: interview.version,
      occurredAt: new Date(STARTED_AT.getTime() + 3_000),
      evaluation: {
        id: parseEvaluationId("evaluation-original"),
        classification: "relevant",
        rubricItems: [
          {
            rubricItemId: parseRubricItemId("rubric-1"),
            evidenceMaterialIds: [parseAnswerMaterialId("material-main")],
            awardedPoints: 80,
            missingOrIncorrectPoints: ["Missing detail"],
          },
        ],
      },
    });
    const originalEvaluation = required(
      evaluated.events.find((event) => event.type === "question_evaluation_recorded"),
    );
    if (originalEvaluation.type !== "question_evaluation_recorded") {
      throw new Error("Expected evaluation event");
    }
    const evaluationWrite: EvaluationPersistence = {
      evaluationId: originalEvaluation.evaluation.id,
      questionPosition: 1,
      evaluation: originalEvaluation.evaluation,
      modelMetadata: metadata,
      createdAt: originalEvaluation.occurredAt,
    };
    await saveSuccessfulCompletion({
      previous: interview,
      current: evaluated.interview,
      events: evaluated.events,
      evaluations: [evaluationWrite],
    });
    interview = required(await interviewRepository.findById(interview.id));
    expect(interview.questions[0]?.evaluation?.id).toBe(parseEvaluationId("evaluation-original"));

    const supplementOperationId = nextOperationId("supplement");
    await createOperationForTest(operationRepository, {
      id: supplementOperationId,
      accountId: interview.accountId,
      interviewId: interview.id,
      type: "submit_supplement",
      idempotencyKey: "supplement",
      expectedVersion: interview.version,
      input: { questionPosition: 1, text: "supplement" },
      createdAt: new Date(STARTED_AT.getTime() + 4_000),
    });
    const supplementPlan = expectPlan(
      handleInterviewCommand(interview, {
        type: "submit_supplement",
        interviewId: interview.id,
        operationId: supplementOperationId,
        expectedVersion: interview.version,
        occurredAt: new Date(STARTED_AT.getTime() + 4_000),
        answerMaterialId: parseAnswerMaterialId("material-supplement"),
        text: "supplement",
      }),
    );
    await saveAcceptedOperation(interview, supplementPlan);
    const followedUp = completeInterviewOperation(supplementPlan.interview, supplementPlan, {
      type: "record_system_follow_up",
      interviewId: interview.id,
      operationId: supplementOperationId,
      expectedVersion: supplementPlan.interview.version,
      occurredAt: new Date(STARTED_AT.getTime() + 4_000),
      messageId: parseMessageId("follow-up-message"),
      goalId: parseFollowUpGoalId("clarification-1"),
      kind: "clarification",
      purpose: "answer_clarification",
      responseClassification: "relevant",
      text: "Please clarify",
    });
    await saveSuccessfulCompletion({
      previous: supplementPlan.interview,
      current: followedUp.interview,
      events: followedUp.events,
    });
    interview = required(await interviewRepository.findById(interview.id));
    expect(interview.questions[0]?.evaluation).toBeNull();
    expect(interview.questions[0]?.outcome).toBeNull();
    expect(interview.questions[0]?.answerMaterial).toHaveLength(2);
    expect(interview.questions[0]?.systemFollowUps).toHaveLength(1);

    const followUpAnswerOperationId = nextOperationId("follow-up-answer");
    await createOperationForTest(operationRepository, {
      id: followUpAnswerOperationId,
      accountId: interview.accountId,
      interviewId: interview.id,
      type: "submit_answer",
      idempotencyKey: "follow-up-answer",
      expectedVersion: interview.version,
      input: { questionPosition: 1, text: "clarified answer" },
      createdAt: new Date(STARTED_AT.getTime() + 6_000),
    });
    const followUpAnswerPlan = expectPlan(
      handleInterviewCommand(interview, {
        type: "submit_answer",
        interviewId: interview.id,
        operationId: followUpAnswerOperationId,
        expectedVersion: interview.version,
        occurredAt: new Date(STARTED_AT.getTime() + 6_000),
        answerMaterialId: parseAnswerMaterialId("material-follow-up"),
        text: "clarified answer",
      }),
    );
    await saveAcceptedOperation(interview, followUpAnswerPlan);
    const replacement = completeInterviewOperation(
      followUpAnswerPlan.interview,
      followUpAnswerPlan,
      {
        type: "record_question_evaluation",
        interviewId: interview.id,
        operationId: followUpAnswerOperationId,
        expectedVersion: followUpAnswerPlan.interview.version,
        occurredAt: new Date(STARTED_AT.getTime() + 7_000),
        evaluation: {
          id: parseEvaluationId("evaluation-replacement"),
          classification: "relevant",
          rubricItems: [
            {
              rubricItemId: parseRubricItemId("rubric-1"),
              evidenceMaterialIds: [parseAnswerMaterialId("material-follow-up")],
              awardedPoints: 100,
              missingOrIncorrectPoints: [],
            },
          ],
        },
      },
    );
    const replacementEvent = required(
      replacement.events.find((event) => event.type === "question_evaluation_recorded"),
    );
    if (replacementEvent.type !== "question_evaluation_recorded") {
      throw new Error("Expected replacement evaluation event");
    }
    await saveSuccessfulCompletion({
      previous: followUpAnswerPlan.interview,
      current: replacement.interview,
      events: replacement.events,
      evaluations: [
        {
          evaluationId: replacementEvent.evaluation.id,
          questionPosition: 1,
          evaluation: replacementEvent.evaluation,
          modelMetadata: metadata,
          createdAt: replacementEvent.occurredAt,
        },
      ],
    });
    const loaded = required(await interviewRepository.findById(interview.id));
    expect(loaded.questions[0]?.evaluation?.id).toBe(parseEvaluationId("evaluation-replacement"));
    expect(loaded.questions[0]?.outcome?.score).toBe(100);
    const detail = required(
      await interviewRepository.findDetailByOwner(interview.id, interview.accountId),
    );
    expect(detail.questions[0]?.messages.map((message) => message.kind)).toEqual([
      "main_answer",
      "supplement",
      "system_follow_up",
      "follow_up_answer",
    ]);
    expect(detail.questions[0]?.messages.slice(1, 3).map((message) => message.createdAt)).toEqual([
      new Date(STARTED_AT.getTime() + 4_000),
      new Date(STARTED_AT.getTime() + 4_000),
    ]);
  });

  it("rejects acceptance against succeeded Operations and accepts succeeded completion and failed cancellation", async () => {
    await seedOwner("operation-matrix-owner");
    let interview = await createInterview({
      ownerId: "operation-matrix-owner",
      interviewId: "operation-matrix-interview",
    });
    const rejectedId = nextOperationId("acceptance-succeeded");
    const rejectedAt = new Date(STARTED_AT.getTime() + 1_000);
    await createOperationForTest(operationRepository, {
      id: rejectedId,
      accountId: interview.accountId,
      interviewId: interview.id,
      type: "submit_answer",
      idempotencyKey: "acceptance-succeeded",
      expectedVersion: interview.version,
      input: { questionPosition: 1, text: "answer" },
      createdAt: rejectedAt,
    });
    const rejectedPlan = expectPlan(
      handleInterviewCommand(interview, {
        type: "submit_answer",
        interviewId: interview.id,
        operationId: rejectedId,
        expectedVersion: interview.version,
        occurredAt: rejectedAt,
        answerMaterialId: parseAnswerMaterialId("acceptance-succeeded-material"),
        text: "answer",
      }),
    );
    await finishOperation(operationRepository, {
      operationId: rejectedId,
      accountId: interview.accountId,
      expectedStatus: "pending",
      status: "succeeded",
      result: { accepted: true },
      completedAt: rejectedAt,
    });
    await expect(
      interviewRepository.save({
        previous: interview,
        current: rejectedPlan.interview,
        events: [],
      }),
    ).rejects.toBeInstanceOf(RepositoryCorruptionError);
    expect(required(await interviewRepository.findById(interview.id)).version).toBe(
      interview.version,
    );

    const cancelledId = nextOperationId("cancel-failed");
    const cancelledAt = new Date(STARTED_AT.getTime() + 2_000);
    await createOperationForTest(operationRepository, {
      id: cancelledId,
      accountId: interview.accountId,
      interviewId: interview.id,
      type: "submit_answer",
      idempotencyKey: "cancel-failed",
      expectedVersion: interview.version,
      input: { questionPosition: 1, text: "cancel" },
      createdAt: cancelledAt,
    });
    const cancelledPlan = expectPlan(
      handleInterviewCommand(interview, {
        type: "submit_answer",
        interviewId: interview.id,
        operationId: cancelledId,
        expectedVersion: interview.version,
        occurredAt: cancelledAt,
        answerMaterialId: parseAnswerMaterialId("cancel-failed-material"),
        text: "cancel",
      }),
    );
    await saveAcceptedOperation(interview, cancelledPlan);
    interview = cancelledPlan.interview;
    const cancelled = cancelInterviewOperation(interview, cancelledPlan);
    await unitOfWork.run(async (repositories) => {
      await finishOperation(repositories.operations, {
        operationId: cancelledId,
        accountId: interview.accountId,
        expectedStatus: "processing",
        status: "failed",
        error: { code: "cancelled" },
        completedAt: new Date(cancelledAt.getTime() + 1),
      });
      await repositories.interviews.save({
        previous: interview,
        current: cancelled,
        events: [],
      });
    });
    expect(required(await interviewRepository.findById(interview.id)).pendingOperation).toBeNull();
    expect(
      required(await operationRepository.findById(cancelledId, interview.accountId)).status,
    ).toBe("failed");
  });

  it("commits Operation success and aggregate transition together and rolls both back on invalid events", async () => {
    await seedOwner("atomic-owner");
    const succeededInterview = await createInterview({
      ownerId: "atomic-owner",
      interviewId: "atomic-success",
    });
    const succeededOperationId = nextOperationId("atomic-success");
    await createOperationForTest(operationRepository, {
      id: succeededOperationId,
      accountId: succeededInterview.accountId,
      interviewId: succeededInterview.id,
      type: "mark_question_unknown",
      idempotencyKey: "atomic-success",
      expectedVersion: succeededInterview.version,
      input: { questionPosition: 1 },
      createdAt: new Date(STARTED_AT.getTime() + 1_000),
    });
    const succeededTransition = expectTransition(
      handleInterviewCommand(succeededInterview, {
        type: "mark_question_unknown",
        interviewId: succeededInterview.id,
        operationId: succeededOperationId,
        expectedVersion: succeededInterview.version,
        occurredAt: new Date(STARTED_AT.getTime() + 1_000),
      }),
    );

    await unitOfWork.run(async (repositories) => {
      await finishOperation(repositories.operations, {
        operationId: succeededOperationId,
        accountId: succeededInterview.accountId,
        expectedStatus: "pending",
        status: "succeeded",
        result: { accepted: true },
        completedAt: new Date(STARTED_AT.getTime() + 1_000),
      });
      await repositories.interviews.save({
        previous: succeededInterview,
        current: succeededTransition.interview,
        events: succeededTransition.events,
      });
    });

    expect(
      required(await interviewRepository.findById(succeededInterview.id)).questions[0]?.outcome
        ?.kind,
    ).toBe("unknown");
    expect(
      required(
        await operationRepository.findById(succeededOperationId, succeededInterview.accountId),
      ).status,
    ).toBe("succeeded");

    await seedOwner("atomic-rollback-owner");
    const rolledBackInterview = await createInterview({
      ownerId: "atomic-rollback-owner",
      interviewId: "atomic-rollback",
      occurredAt: new Date(STARTED_AT.getTime() + 2_000),
    });
    const rolledBackOperationId = nextOperationId("atomic-rollback");
    await createOperationForTest(operationRepository, {
      id: rolledBackOperationId,
      accountId: rolledBackInterview.accountId,
      interviewId: rolledBackInterview.id,
      type: "mark_question_unknown",
      idempotencyKey: "atomic-rollback",
      expectedVersion: rolledBackInterview.version,
      input: { questionPosition: 1 },
      createdAt: new Date(STARTED_AT.getTime() + 3_000),
    });
    const rolledBackTransition = expectTransition(
      handleInterviewCommand(rolledBackInterview, {
        type: "mark_question_unknown",
        interviewId: rolledBackInterview.id,
        operationId: rolledBackOperationId,
        expectedVersion: rolledBackInterview.version,
        occurredAt: new Date(STARTED_AT.getTime() + 3_000),
      }),
    );

    await expect(
      unitOfWork.run(async (repositories) => {
        await finishOperation(repositories.operations, {
          operationId: rolledBackOperationId,
          accountId: rolledBackInterview.accountId,
          expectedStatus: "pending",
          status: "succeeded",
          result: { accepted: true },
          completedAt: new Date(STARTED_AT.getTime() + 3_000),
        });
        await repositories.interviews.save({
          previous: rolledBackInterview,
          current: rolledBackTransition.interview,
          events: [],
        });
      }),
    ).rejects.toBeInstanceOf(RepositoryCorruptionError);

    const rolledBackAggregate = required(
      await interviewRepository.findById(rolledBackInterview.id),
    );
    expect(rolledBackAggregate.version).toBe(rolledBackInterview.version);
    expect(rolledBackAggregate.questions[0]?.outcome).toBeNull();
    expect(
      required(
        await operationRepository.findById(rolledBackOperationId, rolledBackInterview.accountId),
      ).status,
    ).toBe("pending");
  });

  it("rejects mismatched answer, evaluation, and follow-up events before any write", async () => {
    await seedOwner("event-owner");
    let interview = await createInterview({
      ownerId: "event-owner",
      interviewId: "event-interview",
    });
    const operationId = nextOperationId("event-answer");
    await createOperationForTest(operationRepository, {
      id: operationId,
      accountId: interview.accountId,
      interviewId: interview.id,
      type: "submit_answer",
      idempotencyKey: "event-answer",
      expectedVersion: interview.version,
      input: { questionPosition: 1, text: "answer" },
      createdAt: new Date(STARTED_AT.getTime() + 1_000),
    });
    const plan = expectPlan(
      handleInterviewCommand(interview, {
        type: "submit_answer",
        interviewId: interview.id,
        operationId,
        expectedVersion: interview.version,
        occurredAt: new Date(STARTED_AT.getTime() + 1_000),
        answerMaterialId: parseAnswerMaterialId("event-material"),
        text: "answer",
      }),
    );
    await saveAcceptedOperation(interview, plan);
    interview = plan.interview;
    const evaluated = completeInterviewOperation(interview, plan, {
      type: "record_question_evaluation",
      interviewId: interview.id,
      operationId,
      expectedVersion: interview.version,
      occurredAt: new Date(STARTED_AT.getTime() + 2_000),
      evaluation: {
        id: parseEvaluationId("event-evaluation"),
        classification: "relevant",
        rubricItems: [
          {
            rubricItemId: parseRubricItemId("rubric-1"),
            evidenceMaterialIds: [parseAnswerMaterialId("event-material")],
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
      throw new Error("Expected evaluation event");
    }
    const evaluationWrite: EvaluationPersistence = {
      evaluationId: evaluationEvent.evaluation.id,
      questionPosition: 1,
      evaluation: evaluationEvent.evaluation,
      modelMetadata: metadata,
      createdAt: evaluationEvent.occurredAt,
    };
    const answerMismatch = evaluated.events.map((event) =>
      event.type === "answer_material_submitted" ? { ...event, text: "different answer" } : event,
    );
    await expect(
      interviewRepository.save({
        previous: interview,
        current: evaluated.interview,
        events: answerMismatch,
        evaluations: [evaluationWrite],
      }),
    ).rejects.toBeInstanceOf(RepositoryCorruptionError);

    const evaluationMismatch = evaluated.events.map((event) =>
      event.type === "question_evaluation_recorded" ? { ...event, questionPosition: 2 } : event,
    );
    await expect(
      interviewRepository.save({
        previous: interview,
        current: evaluated.interview,
        events: evaluationMismatch,
        evaluations: [evaluationWrite],
      }),
    ).rejects.toBeInstanceOf(RepositoryCorruptionError);

    const followedUp = completeInterviewOperation(interview, plan, {
      type: "record_system_follow_up",
      interviewId: interview.id,
      operationId,
      expectedVersion: interview.version,
      occurredAt: new Date(STARTED_AT.getTime() + 2_000),
      messageId: parseMessageId("event-follow-up"),
      goalId: parseFollowUpGoalId("clarification-1"),
      kind: "clarification",
      purpose: "answer_clarification",
      responseClassification: "relevant",
      text: "Please clarify",
    });
    const followUpMismatch = followedUp.events.map((event) =>
      event.type === "system_follow_up_recorded" ? { ...event, questionPosition: 2 } : event,
    );
    await expect(
      interviewRepository.save({
        previous: interview,
        current: followedUp.interview,
        events: followUpMismatch,
      }),
    ).rejects.toBeInstanceOf(RepositoryCorruptionError);

    const unchanged = required(await interviewRepository.findById(interview.id));
    expect(unchanged.version).toBe(interview.version);
    expect(unchanged.phase).toBe("processing");
    expect(unchanged.questions[0]?.answerMaterial).toHaveLength(0);
  });

  it("rejects optimistic competing saves and distinguishes the current version", async () => {
    await seedOwner("optimistic-owner");
    const interview = await createInterview({
      ownerId: "optimistic-owner",
      interviewId: "optimistic-interview",
    });

    const first = expectTransition(
      handleInterviewCommand(interview, {
        type: "mark_question_unknown",
        interviewId: interview.id,
        operationId: nextOperationId("first"),
        expectedVersion: interview.version,
        occurredAt: new Date(STARTED_AT.getTime() + 1_000),
      }),
    );
    const second = expectTransition(
      handleInterviewCommand(interview, {
        type: "skip_question",
        interviewId: interview.id,
        operationId: nextOperationId("second"),
        expectedVersion: interview.version,
        occurredAt: new Date(STARTED_AT.getTime() + 2_000),
      }),
    );

    await interviewRepository.save({
      previous: interview,
      current: first.interview,
      events: first.events,
    });
    await expect(
      interviewRepository.save({
        previous: interview,
        current: second.interview,
        events: second.events,
      }),
    ).rejects.toMatchObject({
      name: "RepositoryVersionConflictError",
      expectedVersion: 1,
      actualVersion: 2,
    } satisfies Partial<RepositoryVersionConflictError>);

    await client.database.delete(interviewSessions).where(eq(interviewSessions.id, interview.id));
    const missing = expectTransition(
      handleInterviewCommand(first.interview, {
        type: "continue_interview",
        interviewId: interview.id,
        operationId: nextOperationId("missing"),
        expectedVersion: first.interview.version,
        occurredAt: new Date(STARTED_AT.getTime() + 3_000),
      }),
    );
    await expect(
      interviewRepository.save({
        previous: first.interview,
        current: missing.interview,
        events: missing.events,
      }),
    ).rejects.toBeInstanceOf(RepositoryNotFoundError);
  });

  it("rejects a minimal report snapshot and leaves report-pending state unchanged", async () => {
    await seedOwner("invalid-report-owner");
    let interview = await createInterview({
      ownerId: "invalid-report-owner",
      interviewId: "invalid-report-interview",
    });
    interview = await completeWithZeroScores(interview, STARTED_AT);
    const reportId = parseReportId("invalid-minimal-report");
    const operationId = nextOperationId("invalid-report");
    const occurredAt = new Date(STARTED_AT.getTime() + 20_000);
    await createOperationForTest(operationRepository, {
      id: operationId,
      accountId: interview.accountId,
      interviewId: interview.id,
      type: "generate_report",
      idempotencyKey: "invalid-report",
      expectedVersion: interview.version,
      input: { reportKind: "complete" },
      createdAt: occurredAt,
    });
    const transition = expectTransition(
      handleInterviewCommand(interview, {
        type: "record_report",
        interviewId: interview.id,
        operationId,
        expectedVersion: interview.version,
        occurredAt,
        reportId,
        reportKind: "complete",
      }),
    );
    await expect(
      unitOfWork.run(async (repositories) => {
        await finishOperation(repositories.operations, {
          operationId,
          accountId: interview.accountId,
          expectedStatus: "pending",
          status: "succeeded",
          result: { reportId },
          completedAt: occurredAt,
        });
        await repositories.interviews.save({
          previous: interview,
          current: transition.interview,
          events: transition.events,
          report: {
            id: reportId,
            kind: "complete",
            schemaVersion: "1.0",
            snapshot: {
              reportId,
              interviewId: interview.id,
              kind: "complete",
              generatedAt: occurredAt.toISOString(),
              overallScore: 0,
            } as ReportPersistence["snapshot"],
            modelMetadata: { ...metadata, purpose: "report_analysis", questionVersion: null },
            createdAt: occurredAt,
          },
        });
      }),
    ).rejects.toBeInstanceOf(RepositoryCorruptionError);

    const unchanged = required(await interviewRepository.findById(interview.id));
    expect(unchanged.status).toBe("report_pending");
    expect(unchanged.version).toBe(interview.version);
    await expect(
      reportRepository.findByInterviewId(interview.id, interview.accountId),
    ).resolves.toBeNull();
    expect(
      required(await operationRepository.findById(operationId, interview.accountId)).status,
    ).toBe("pending");
  });

  it.each(["domain coverage", "timestamp"] as const)(
    "rejects report snapshots with invalid %s",
    async (invalidField) => {
      const suffix = invalidField === "domain coverage" ? "domain" : "timestamp";
      await seedOwner(`invalid-report-${suffix}-owner`);
      let interview = await createInterview({
        ownerId: `invalid-report-${suffix}-owner`,
        interviewId: `invalid-report-${suffix}-interview`,
      });
      interview = await completeWithZeroScores(interview, STARTED_AT);
      const createdAt = new Date(STARTED_AT.getTime() + 20_000);
      await client.database
        .update(interviewSessions)
        .set({
          status: "completed",
          activePhase: null,
          pendingReportKind: null,
          reportRequestedAt: null,
          endedAt: createdAt,
        })
        .where(eq(interviewSessions.id, interview.id));
      const persistence = reportPersistence(
        interview,
        "complete",
        `invalid-report-${suffix}`,
        createdAt,
      );
      const questions =
        invalidField === "domain coverage"
          ? persistence.snapshot.questions.map((question, index) =>
              index === 4 ? { ...question, domain: "go_language" as const } : question,
            )
          : persistence.snapshot.questions;
      const snapshot =
        invalidField === "domain coverage"
          ? {
              ...persistence.snapshot,
              questions,
              domains: [
                {
                  status: "assessed" as const,
                  domain: "go_language" as const,
                  score: 0,
                  questionCount: 2,
                },
                ...DOMAINS.slice(1, 4).map((domain) => ({
                  status: "assessed" as const,
                  domain,
                  score: 0,
                  questionCount: 1,
                })),
                {
                  status: "unassessed" as const,
                  domain: "cache_messaging_distributed" as const,
                },
                {
                  status: "unassessed" as const,
                  domain: "testing_observability_engineering" as const,
                },
              ],
            }
          : { ...persistence.snapshot, generatedAt: "1" };

      await expect(
        reportRepository.insert({
          interviewId: interview.id,
          accountId: interview.accountId,
          ...persistence,
          snapshot,
        }),
      ).rejects.toBeInstanceOf(RepositoryCorruptionError);
    },
  );

  it.each(["fabricated Rubric item", "mismatched awarded points"] as const)(
    "rejects report feedback with %s",
    async (corruptionKind) => {
      const suffix = corruptionKind === "fabricated Rubric item" ? "fabricated" : "award";
      await seedOwner(`report-facts-${suffix}-owner`);
      const customBlueprint = blueprint(`report-facts-${suffix}`);
      const first = required(customBlueprint.questions[0]);
      const twoItemBlueprint: InterviewBlueprint = {
        ...customBlueprint,
        questions: [
          {
            ...first,
            question: {
              ...first.question,
              rubric: [
                {
                  id: parseRubricItemId("rubric-1-a"),
                  description: "First required point",
                  weight: 50,
                },
                {
                  id: parseRubricItemId("rubric-1-b"),
                  description: "Second required point",
                  weight: 50,
                },
              ],
            },
          },
          ...customBlueprint.questions.slice(1),
        ],
      };
      let interview = await createInterview({
        ownerId: `report-facts-${suffix}-owner`,
        interviewId: `report-facts-${suffix}-interview`,
        blueprint: twoItemBlueprint,
      });
      const answerAt = new Date(STARTED_AT.getTime() + 1_000);
      const answerOperationId = nextOperationId(`report-facts-${suffix}-answer`);
      const materialId = parseAnswerMaterialId(`report-facts-${suffix}-material`);
      await createOperationForTest(operationRepository, {
        id: answerOperationId,
        accountId: interview.accountId,
        interviewId: interview.id,
        type: "submit_answer",
        idempotencyKey: `report-facts-${suffix}-answer`,
        expectedVersion: interview.version,
        input: { questionPosition: 1, text: "answer" },
        createdAt: answerAt,
      });
      const answerPlan = expectPlan(
        handleInterviewCommand(interview, {
          type: "submit_answer",
          interviewId: interview.id,
          operationId: answerOperationId,
          expectedVersion: interview.version,
          occurredAt: answerAt,
          answerMaterialId: materialId,
          text: "answer",
        }),
      );
      await saveAcceptedOperation(interview, answerPlan);
      const evaluated = completeInterviewOperation(answerPlan.interview, answerPlan, {
        type: "record_question_evaluation",
        interviewId: interview.id,
        operationId: answerOperationId,
        expectedVersion: answerPlan.interview.version,
        occurredAt: new Date(answerAt.getTime() + 1),
        evaluation: {
          id: parseEvaluationId(`report-facts-${suffix}-evaluation`),
          classification: "relevant",
          rubricItems: [
            {
              rubricItemId: parseRubricItemId("rubric-1-a"),
              evidenceMaterialIds: [materialId],
              awardedPoints: 40,
              missingOrIncorrectPoints: [],
            },
            {
              rubricItemId: parseRubricItemId("rubric-1-b"),
              evidenceMaterialIds: [materialId],
              awardedPoints: 40,
              missingOrIncorrectPoints: [],
            },
          ],
        },
      });
      const evaluationEvent = required(
        evaluated.events.find((event) => event.type === "question_evaluation_recorded"),
      );
      if (evaluationEvent.type !== "question_evaluation_recorded") {
        throw new Error("Expected evaluation event");
      }
      await saveSuccessfulCompletion({
        previous: answerPlan.interview,
        current: evaluated.interview,
        events: evaluated.events,
        evaluations: [
          {
            evaluationId: evaluationEvent.evaluation.id,
            questionPosition: 1,
            evaluation: evaluationEvent.evaluation,
            modelMetadata: metadata,
            createdAt: evaluationEvent.occurredAt,
          },
        ],
      });
      interview = await saveImmediate(
        evaluated.interview,
        "end_interview_early",
        new Date(answerAt.getTime() + 2),
      );

      const reportAt = new Date(answerAt.getTime() + 3);
      const persistence = reportPersistence(
        interview,
        "incomplete",
        `report-facts-${suffix}`,
        reportAt,
      );
      const feedback = required(persistence.snapshot.questions[0]);
      const points = [...feedback.matchedKnowledgePoints];
      const corruptedPersistence: ReportPersistence = {
        ...persistence,
        snapshot: {
          ...persistence.snapshot,
          questions: [
            {
              ...feedback,
              matchedKnowledgePoints:
                corruptionKind === "fabricated Rubric item"
                  ? [
                      {
                        ...required(points[0]),
                        rubricItemId: parseRubricItemId("fabricated-rubric"),
                      },
                      required(points[1]),
                    ]
                  : [
                      { ...required(points[0]), awardedPoints: 30 },
                      { ...required(points[1]), awardedPoints: 50 },
                    ],
            },
          ],
        },
      };
      const reportOperationId = nextOperationId(`report-facts-${suffix}-operation`);
      await createOperationForTest(operationRepository, {
        id: reportOperationId,
        accountId: interview.accountId,
        interviewId: interview.id,
        type: "generate_report",
        idempotencyKey: `report-facts-${suffix}-operation`,
        expectedVersion: interview.version,
        input: { reportKind: "incomplete" },
        createdAt: reportAt,
      });
      const transition = expectTransition(
        handleInterviewCommand(interview, {
          type: "record_report",
          interviewId: interview.id,
          operationId: reportOperationId,
          expectedVersion: interview.version,
          occurredAt: reportAt,
          reportId: corruptedPersistence.id,
          reportKind: "incomplete",
        }),
      );
      await expect(
        unitOfWork.run(async (repositories) => {
          await finishOperation(repositories.operations, {
            operationId: reportOperationId,
            accountId: interview.accountId,
            expectedStatus: "pending",
            status: "succeeded",
            result: { reportId: corruptedPersistence.id },
            completedAt: reportAt,
          });
          await repositories.interviews.save({
            previous: interview,
            current: transition.interview,
            events: transition.events,
            report: corruptedPersistence,
          });
        }),
      ).rejects.toBeInstanceOf(RepositoryCorruptionError);
    },
  );

  it("persists a partial Rubric award and its missing facts without double-counting", async () => {
    await seedOwner("partial-report-owner");
    let interview = await createInterview({
      ownerId: "partial-report-owner",
      interviewId: "partial-report-interview",
    });
    const operationId = nextOperationId("partial-report-answer");
    const materialId = parseAnswerMaterialId("partial-report-material");
    const answerAt = new Date(STARTED_AT.getTime() + 1_000);
    await createOperationForTest(operationRepository, {
      id: operationId,
      accountId: interview.accountId,
      interviewId: interview.id,
      type: "submit_answer",
      idempotencyKey: "partial-report-answer",
      expectedVersion: interview.version,
      input: { questionPosition: 1, text: "partial answer" },
      createdAt: answerAt,
    });
    const plan = expectPlan(
      handleInterviewCommand(interview, {
        type: "submit_answer",
        interviewId: interview.id,
        operationId,
        expectedVersion: interview.version,
        occurredAt: answerAt,
        answerMaterialId: materialId,
        text: "partial answer",
      }),
    );
    await saveAcceptedOperation(interview, plan);
    const evaluated = completeInterviewOperation(plan.interview, plan, {
      type: "record_question_evaluation",
      interviewId: interview.id,
      operationId,
      expectedVersion: plan.interview.version,
      occurredAt: new Date(answerAt.getTime() + 1),
      evaluation: {
        id: parseEvaluationId("partial-report-evaluation"),
        classification: "relevant",
        rubricItems: [
          {
            rubricItemId: parseRubricItemId("rubric-1"),
            evidenceMaterialIds: [materialId],
            awardedPoints: 80,
            missingOrIncorrectPoints: ["Missing detail", "Incorrect limitation"],
          },
        ],
      },
    });
    const evaluationEvent = required(
      evaluated.events.find((event) => event.type === "question_evaluation_recorded"),
    );
    if (evaluationEvent.type !== "question_evaluation_recorded") {
      throw new Error("Expected evaluation event");
    }
    await saveSuccessfulCompletion({
      previous: plan.interview,
      current: evaluated.interview,
      events: evaluated.events,
      evaluations: [
        {
          evaluationId: evaluationEvent.evaluation.id,
          questionPosition: 1,
          evaluation: evaluationEvent.evaluation,
          modelMetadata: metadata,
          createdAt: evaluationEvent.occurredAt,
        },
      ],
    });
    interview = await saveImmediate(
      evaluated.interview,
      "end_interview_early",
      new Date(answerAt.getTime() + 2),
    );
    interview = await finishReport(interview, "partial-report", new Date(answerAt.getTime() + 3));

    const stored = required(
      await reportRepository.findByInterviewId(interview.id, interview.accountId),
    );
    expect(stored.snapshot.questions[0]).toMatchObject({
      score: 80,
      matchedKnowledgePoints: [
        {
          rubricItemId: parseRubricItemId("rubric-1"),
          awardedPoints: 80,
        },
      ],
      missingOrIncorrectPoints: [
        { rubricItemId: parseRubricItemId("rubric-1"), summary: "Missing detail" },
        { rubricItemId: parseRubricItemId("rubric-1"), summary: "Incorrect limitation" },
      ],
    });
  });

  it("rejects corrupt pending Operation type/phase matrices during hydration", async () => {
    await seedOwner("pending-matrix-owner");
    const interview = await createInterview({
      ownerId: "pending-matrix-owner",
      interviewId: "pending-matrix-interview",
    });
    const operationId = nextOperationId("pending-matrix");
    await createOperationForTest(operationRepository, {
      id: operationId,
      accountId: interview.accountId,
      interviewId: interview.id,
      type: "request_question_clarification",
      idempotencyKey: "pending-matrix",
      expectedVersion: interview.version,
      input: { questionPosition: 1 },
      createdAt: new Date(STARTED_AT.getTime() + 1_000),
    });
    const plan = expectPlan(
      handleInterviewCommand(interview, {
        type: "request_question_clarification",
        interviewId: interview.id,
        operationId,
        expectedVersion: interview.version,
        occurredAt: new Date(STARTED_AT.getTime() + 1_000),
      }),
    );
    await saveAcceptedOperation(interview, plan);
    await expect(interviewRepository.findById(interview.id)).resolves.toEqual(plan.interview);

    await client.database
      .update(interviewSessions)
      .set({ pendingOperationPreviousPhase: "awaiting_continue" })
      .where(eq(interviewSessions.id, interview.id));
    await expect(interviewRepository.findById(interview.id)).rejects.toBeInstanceOf(
      RepositoryCorruptionError,
    );
    await client.database
      .update(interviewSessions)
      .set({ pendingOperationPreviousPhase: "awaiting_response" })
      .where(eq(interviewSessions.id, interview.id));
    await finishOperation(operationRepository, {
      operationId,
      accountId: interview.accountId,
      expectedStatus: "processing",
      status: "succeeded",
      result: { accepted: true },
      completedAt: new Date(STARTED_AT.getTime() + 2_000),
    });
    await expect(interviewRepository.findById(interview.id)).rejects.toBeInstanceOf(
      RepositoryCorruptionError,
    );
  });

  it("validates report reads through the owning aggregate lifecycle", async () => {
    await seedOwner("report-read-empty-owner");
    let empty = await createInterview({
      ownerId: "report-read-empty-owner",
      interviewId: "report-read-empty",
    });
    await expect(reportRepository.findByInterviewId(empty.id, empty.accountId)).resolves.toBeNull();
    empty = await saveImmediate(empty, "abandon_interview", new Date(STARTED_AT.getTime() + 1_000));
    await expect(reportRepository.findByInterviewId(empty.id, empty.accountId)).resolves.toBeNull();

    await seedOwner("report-read-pending-owner");
    let pending = await createInterview({
      ownerId: "report-read-pending-owner",
      interviewId: "report-read-pending",
    });
    pending = await completeWithZeroScores(pending, STARTED_AT);
    pending = await finishReport(
      pending,
      "report-read-pending-report",
      new Date(STARTED_AT.getTime() + 30_000),
    );
    await client.database
      .update(interviewSessions)
      .set({
        status: "report_pending",
        pendingReportKind: "complete",
        reportRequestedAt: new Date(STARTED_AT.getTime() + 29_000),
        endedAt: null,
      })
      .where(eq(interviewSessions.id, pending.id));
    await expect(
      reportRepository.findByInterviewId(pending.id, pending.accountId),
    ).rejects.toBeInstanceOf(RepositoryCorruptionError);

    await seedOwner("report-read-kind-owner");
    let kindMismatch = await createInterview({
      ownerId: "report-read-kind-owner",
      interviewId: "report-read-kind",
    });
    kindMismatch = await completeWithZeroScores(kindMismatch, STARTED_AT);
    const kindMismatchAt = new Date(STARTED_AT.getTime() + 40_000);
    kindMismatch = await finishReport(kindMismatch, "report-read-kind-report", kindMismatchAt);
    const incompletePersistence = reportPersistence(
      kindMismatch,
      "incomplete",
      "report-read-kind-report",
      kindMismatchAt,
    );
    await client.database
      .update(reports)
      .set({
        kind: "incomplete",
        snapshot: incompletePersistence.snapshot,
      })
      .where(eq(reports.interviewId, kindMismatch.id));
    await expect(
      reportRepository.findByInterviewId(kindMismatch.id, kindMismatch.accountId),
    ).rejects.toBeInstanceOf(RepositoryCorruptionError);

    await seedOwner("report-read-future-owner");
    let future = await createInterview({
      ownerId: "report-read-future-owner",
      interviewId: "report-read-future",
    });
    future = await saveImmediate(
      future,
      "mark_question_unknown",
      new Date(STARTED_AT.getTime() + 50_000),
    );
    future = await saveImmediate(
      future,
      "end_interview_early",
      new Date(STARTED_AT.getTime() + 51_000),
    );
    future = await finishReport(
      future,
      "report-read-future-report",
      new Date(STARTED_AT.getTime() + 52_000),
    );
    await client.database
      .update(sessionQuestionSnapshots)
      .set({ outcomeKind: "unknown", score: 0, zeroScoreReason: "unknown" })
      .where(
        and(
          eq(sessionQuestionSnapshots.interviewId, future.id),
          eq(sessionQuestionSnapshots.position, 2),
        ),
      );
    await expect(
      reportRepository.findByInterviewId(future.id, future.accountId),
    ).rejects.toBeInstanceOf(RepositoryCorruptionError);
  });

  it("rejects corrupted future, active, processing, and report-pending question matrices", async () => {
    await seedOwner("future-corrupt-owner");
    const future = await createInterview({
      ownerId: "future-corrupt-owner",
      interviewId: "future-corrupt-interview",
    });
    await client.database
      .update(sessionQuestionSnapshots)
      .set({ outcomeKind: "unknown", score: 0, zeroScoreReason: "unknown" })
      .where(
        and(
          eq(sessionQuestionSnapshots.interviewId, future.id),
          eq(sessionQuestionSnapshots.position, 2),
        ),
      );
    await expect(interviewRepository.findById(future.id)).rejects.toBeInstanceOf(
      RepositoryCorruptionError,
    );

    await seedOwner("continue-corrupt-owner");
    const awaitingContinue = await createInterview({
      ownerId: "continue-corrupt-owner",
      interviewId: "continue-corrupt-interview",
    });
    await client.database
      .update(interviewSessions)
      .set({ activePhase: "awaiting_continue" })
      .where(eq(interviewSessions.id, awaitingContinue.id));
    await expect(interviewRepository.findById(awaitingContinue.id)).rejects.toBeInstanceOf(
      RepositoryCorruptionError,
    );

    await seedOwner("processing-corrupt-owner");
    const processing = await createInterview({
      ownerId: "processing-corrupt-owner",
      interviewId: "processing-corrupt-interview",
    });
    const processingOperationId = nextOperationId("processing-corrupt");
    const processingAt = new Date(STARTED_AT.getTime() + 1_000);
    await createOperationForTest(operationRepository, {
      id: processingOperationId,
      accountId: processing.accountId,
      interviewId: processing.id,
      type: "submit_supplement",
      idempotencyKey: "processing-corrupt",
      expectedVersion: processing.version,
      input: { questionPosition: 1, text: "supplement" },
      createdAt: processingAt,
    });
    await claimOperationForTest(
      operationRepository,
      processingOperationId,
      processing.accountId,
      processingAt,
    );
    await client.database
      .update(interviewSessions)
      .set({
        version: processing.version + 1,
        activePhase: "processing",
        pendingOperationId: processingOperationId,
        pendingOperationKind: "answer_analysis",
        pendingOperationQuestionPosition: 1,
        pendingOperationAcceptedAt: processingAt,
        pendingOperationPreviousPhase: "awaiting_continue",
        lastEffectiveActivityAt: processingAt,
      })
      .where(eq(interviewSessions.id, processing.id));
    await expect(interviewRepository.findById(processing.id)).rejects.toBeInstanceOf(
      RepositoryCorruptionError,
    );

    await seedOwner("report-pending-corrupt-owner");
    const reportPending = await createInterview({
      ownerId: "report-pending-corrupt-owner",
      interviewId: "report-pending-corrupt-interview",
    });
    await client.database
      .update(interviewSessions)
      .set({
        status: "report_pending",
        activePhase: null,
        pendingReportKind: "complete",
        reportRequestedAt: new Date(STARTED_AT.getTime() + 1_000),
      })
      .where(eq(interviewSessions.id, reportPending.id));
    await expect(interviewRepository.findById(reportPending.id)).rejects.toBeInstanceOf(
      RepositoryCorruptionError,
    );
  });

  it("stores the final report transition atomically and rejects duplicate immutable reports", async () => {
    await seedOwner("report-owner");
    let interview = await createInterview({
      ownerId: "report-owner",
      interviewId: "report-interview",
    });
    interview = await completeWithZeroScores(interview, STARTED_AT);
    expect(interview.status).toBe("report_pending");
    const pendingDetail = required(
      await interviewRepository.findDetailByOwner(interview.id, interview.accountId),
    );
    expect(pendingDetail.questions).toHaveLength(5);
    expect(pendingDetail.interview.blueprint.questions).toHaveLength(5);
    expect(pendingDetail.interview.questions).toHaveLength(5);
    const reportOperationId = nextOperationId("report-complete");
    const reportCreatedAt = new Date(STARTED_AT.getTime() + 20_000);
    await createOperationForTest(operationRepository, {
      id: reportOperationId,
      accountId: interview.accountId,
      interviewId: interview.id,
      type: "generate_report",
      idempotencyKey: "report-complete",
      expectedVersion: interview.version,
      input: { reportKind: "complete" },
      createdAt: reportCreatedAt,
    });
    const reportTransition = expectTransition(
      handleInterviewCommand(interview, {
        type: "record_report",
        interviewId: interview.id,
        operationId: reportOperationId,
        expectedVersion: interview.version,
        occurredAt: reportCreatedAt,
        reportId: parseReportId("report-complete"),
        reportKind: "complete",
      }),
    );
    await unitOfWork.run(async (repositories) => {
      await finishOperation(repositories.operations, {
        operationId: reportOperationId,
        accountId: interview.accountId,
        expectedStatus: "pending",
        status: "succeeded",
        result: { reportId: "report-complete" },
        completedAt: reportCreatedAt,
      });
      await repositories.interviews.save({
        previous: interview,
        current: reportTransition.interview,
        events: reportTransition.events,
        report: reportPersistence(interview, "complete", "report-complete", reportCreatedAt, 0),
      });
    });
    interview = reportTransition.interview;

    const loaded = required(await interviewRepository.findById(interview.id));
    expect(loaded.status).toBe("completed");
    expect(loaded.reportId).toBe(parseReportId("report-complete"));
    await expect(
      reportRepository.findByInterviewId(interview.id, interview.accountId),
    ).resolves.toMatchObject({
      id: parseReportId("report-complete"),
      kind: "complete",
    });
    expect(
      required(await operationRepository.findById(reportOperationId, interview.accountId)).status,
    ).toBe("succeeded");
    await expect(
      reportRepository.insert({
        interviewId: interview.id,
        accountId: interview.accountId,
        ...reportPersistence(
          interview,
          "complete",
          "report-duplicate",
          new Date(STARTED_AT.getTime() + 21_000),
        ),
      }),
    ).rejects.toBeInstanceOf(RepositoryImmutableConflictError);

    const persisted = required(
      (
        await client.database
          .select({ snapshot: reports.snapshot })
          .from(reports)
          .where(eq(reports.interviewId, interview.id))
      )[0],
    ).snapshot;
    const firstFeedback = required(persisted.questions[0]);
    const fabricatedQuestionId = parseQuestionId("fabricated-history-question");
    const replaceQuestionEvidence = (
      evidence: typeof firstFeedback.evidence,
    ): typeof firstFeedback.evidence =>
      evidence.map((reference) =>
        reference.source === "question_snapshot"
          ? { source: "question_snapshot", questionId: fabricatedQuestionId }
          : reference,
      );
    const corruptSnapshot: ImmutableReportSnapshot = {
      ...persisted,
      questionVersions: persisted.questionVersions.map((version, index) =>
        index === 0 ? { ...version, questionId: fabricatedQuestionId } : version,
      ),
      questions: [
        {
          ...firstFeedback,
          questionId: fabricatedQuestionId,
          matchedKnowledgePoints: firstFeedback.matchedKnowledgePoints.map((point) => ({
            ...point,
            evidence: replaceQuestionEvidence(point.evidence),
          })),
          missingOrIncorrectPoints: firstFeedback.missingOrIncorrectPoints.map((point) => ({
            ...point,
            evidence: replaceQuestionEvidence(point.evidence),
          })),
          evidence: replaceQuestionEvidence(firstFeedback.evidence),
        },
        ...persisted.questions.slice(1),
      ],
    };
    await client.database
      .update(reports)
      .set({ snapshot: corruptSnapshot })
      .where(eq(reports.interviewId, interview.id));
    await expect(interviewRepository.findById(interview.id)).rejects.toBeInstanceOf(
      RepositoryCorruptionError,
    );
    await expect(interviewRepository.listHistory(interview.accountId)).rejects.toBeInstanceOf(
      RepositoryCorruptionError,
    );
    await expect(
      reportRepository.findByInterviewId(interview.id, interview.accountId),
    ).rejects.toBeInstanceOf(RepositoryCorruptionError);
  });

  it("scopes ownership, orders state-aware history, and hides deletion-marked records", async () => {
    await seedOwner("history-owner");
    await seedOwner("other-owner");
    const accountId = parseAccountId("history-owner");
    const otherAccountId = parseAccountId("other-owner");

    let completed = await createInterview({
      ownerId: "history-owner",
      interviewId: "history-completed",
      occurredAt: new Date(STARTED_AT.getTime() + 1_000),
    });

    completed = await completeWithZeroScores(completed, new Date(STARTED_AT.getTime() + 1_000));
    completed = await finishReport(
      completed,
      "history-complete-report",
      new Date(STARTED_AT.getTime() + 30_000),
      0,
    );

    let early = await createInterview({
      ownerId: "history-owner",
      interviewId: "history-early",
      occurredAt: new Date(STARTED_AT.getTime() + 40_000),
    });
    early = await saveImmediate(
      early,
      "mark_question_unknown",
      new Date(STARTED_AT.getTime() + 41_000),
    );
    early = await saveImmediate(
      early,
      "end_interview_early",
      new Date(STARTED_AT.getTime() + 42_000),
    );
    const incompletePendingDetail = required(
      await interviewRepository.findDetailByOwner(early.id, accountId),
    );
    expect(incompletePendingDetail.questions).toHaveLength(1);
    expect(incompletePendingDetail.interview.blueprint.questions).toHaveLength(1);
    expect(incompletePendingDetail.interview.questions).toHaveLength(1);
    early = await finishReport(
      early,
      "history-incomplete-report",
      new Date(STARTED_AT.getTime() + 43_000),
    );

    let abandoned = await createInterview({
      ownerId: "history-owner",
      interviewId: "history-abandoned",
      occurredAt: new Date(STARTED_AT.getTime() + 50_000),
    });
    abandoned = await saveImmediate(
      abandoned,
      "abandon_interview",
      new Date(STARTED_AT.getTime() + 51_000),
    );

    const history = await interviewRepository.listHistory(accountId);
    expect(history.map((entry) => entry.interviewId)).toEqual([
      abandoned.id,
      early.id,
      completed.id,
    ]);
    expect(history.map((entry) => [entry.status, entry.overallScore])).toEqual([
      ["abandoned", null],
      ["early_ended", null],
      ["completed", 0],
    ]);
    const completedDetail = required(
      await interviewRepository.findDetailByOwner(completed.id, accountId),
    );
    expect(completedDetail.questions.map((question) => question.displayedQuestion)).toEqual([
      "Displayed question 1",
      "Displayed question 2",
      "Displayed question 3",
      "Displayed question 4",
      "Displayed question 5",
    ]);
    expect(completedDetail.interview.blueprint.questions).toHaveLength(5);
    expect(completedDetail.interview.questions).toHaveLength(5);

    for (const partial of [early, abandoned]) {
      const detail = required(await interviewRepository.findDetailByOwner(partial.id, accountId));
      expect(detail.questions.map((question) => question.displayedQuestion)).toEqual([
        "Displayed question 1",
      ]);
      expect(detail.interview.blueprint.questions.map((item) => item.position)).toEqual([1]);
      expect(detail.interview.questions.map((question) => question.position)).toEqual([1]);
      expect(JSON.stringify(detail)).not.toContain("Displayed question 2");
      expect(JSON.stringify(detail)).not.toContain("bank-question-2");
    }
    await expect(interviewRepository.findById(completed.id, otherAccountId)).resolves.toBeNull();
    await expect(
      interviewRepository.findDetailByOwner(completed.id, otherAccountId),
    ).resolves.toBeNull();
    await expect(
      reportRepository.findByInterviewId(completed.id, otherAccountId),
    ).resolves.toBeNull();

    await client.database
      .update(interviewSessions)
      .set({ deletionRequestedAt: new Date(STARTED_AT.getTime() + 60_000) })
      .where(eq(interviewSessions.id, completed.id));
    await expect(interviewRepository.findById(completed.id, accountId)).resolves.toBeNull();
    await expect(reportRepository.findByInterviewId(completed.id, accountId)).resolves.toBeNull();
    expect(
      (await interviewRepository.listHistory(accountId)).map((entry) => entry.interviewId),
    ).toEqual([abandoned.id, early.id]);
  });

  it("loads one or twenty history entries with a bounded constant query count", async () => {
    await seedOwner("history-query-owner");
    const accountId = parseAccountId("history-query-owner");
    let queryCount = 0;
    const countedClient = createDatabaseClient({
      databaseUrl,
      max: 1,
      logger: {
        logQuery() {
          queryCount += 1;
        },
      },
    });
    const countedRepository = new PgInterviewRepository(countedClient.database);

    try {
      const interview = await createInterview({
        ownerId: "history-query-owner",
        interviewId: "history-query-1",
      });
      await saveImmediate(interview, "abandon_interview", new Date(STARTED_AT.getTime() + 1_000));

      queryCount = 0;
      await expect(countedRepository.listHistory(accountId)).resolves.toHaveLength(1);
      const oneEntryQueryCount = queryCount;

      for (let index = 2; index <= 20; index += 1) {
        const next = await createInterview({
          ownerId: "history-query-owner",
          interviewId: `history-query-${index}`,
          occurredAt: new Date(STARTED_AT.getTime() + index * 2_000),
        });
        await saveImmediate(
          next,
          "abandon_interview",
          new Date(STARTED_AT.getTime() + index * 2_000 + 1_000),
        );
      }

      queryCount = 0;
      await expect(countedRepository.listHistory(accountId)).resolves.toHaveLength(20);
      const twentyEntryQueryCount = queryCount;

      expect(oneEntryQueryCount).toBeLessThanOrEqual(5);
      expect(twentyEntryQueryCount).toBeLessThanOrEqual(5);
      expect(twentyEntryQueryCount).toBe(oneEntryQueryCount);
    } finally {
      await countedClient.close();
    }
  });

  it("loads duplicate scoped Operations and completes through an owned lease", async () => {
    await seedOwner("operation-owner");
    await seedOwner("operation-other");
    const interview = await createInterview({
      ownerId: "operation-owner",
      interviewId: "operation-interview",
    });
    const operationId = parseOperationId("operation-basic");
    const created = await createOperationForTest(operationRepository, {
      id: operationId,
      accountId: interview.accountId,
      interviewId: interview.id,
      type: "submit_answer",
      idempotencyKey: "shared-key",
      expectedVersion: interview.version,
      input: { text: "answer" },
      createdAt: STARTED_AT,
    });
    expect(created.status).toBe("pending");
    await expect(
      operationRepository.findByIdempotencyKey(
        interview.accountId,
        "interview-command",
        "shared-key",
      ),
    ).resolves.toEqual(created);
    await expect(
      operationRepository.findById(operationId, parseAccountId("operation-other")),
    ).resolves.toBeNull();
    const duplicate = await operationRepository.createOrLoad({
      ...created,
      id: parseOperationId("operation-duplicate-key"),
      type: "submit_answer",
      createdAt: STARTED_AT,
    });
    expect(duplicate).toEqual({ operation: created, created: false });

    const otherScope = await createOperationForTest(operationRepository, {
      id: parseOperationId("operation-other-scope"),
      accountId: interview.accountId,
      interviewId: interview.id,
      idempotencyScope: "supplement-command",
      type: "submit_supplement",
      idempotencyKey: "shared-key",
      expectedVersion: interview.version,
      input: { text: "supplement" },
      createdAt: STARTED_AT,
    });
    expect(otherScope.type).toBe("submit_supplement");
    await finishOperation(operationRepository, {
      operationId,
      accountId: interview.accountId,
      expectedStatus: "pending",
      status: "succeeded",
      result: { accepted: true },
      completedAt: new Date(STARTED_AT.getTime() + 1_000),
    });
    const succeeded = required(
      await operationRepository.findById(operationId, interview.accountId),
    );
    expect(succeeded.status).toBe("succeeded");
    expect(succeeded.result).toEqual({ accepted: true });
  });

  it("rolls transactions back and releases the checked-out connection", async () => {
    await expect(
      withTransaction(
        client.database,
        async (transaction) => {
          await transaction.insert(user).values({
            id: "rolled-back-owner",
            name: "Rolled Back",
            email: "rolled-back@example.com",
          });
          throw new Error("rollback sentinel");
        },
        { isolationLevel: "serializable" },
      ),
    ).rejects.toThrow("rollback sentinel");

    const rows = await client.database
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, "rolled-back-owner"));
    expect(rows).toHaveLength(0);
    expect(client.pool.idleCount).toBe(client.pool.totalCount);
  });

  it("throws an explicit corruption error for invalid persisted JSON", async () => {
    await seedOwner("corrupt-owner");
    await withTransaction(client.database, async (transaction) => {
      await transaction.insert(interviewSessions).values({
        id: "corrupt-interview",
        ownerUserId: "corrupt-owner",
        selectedQuestionCount: 5,
        selectionSeed: "corrupt-seed",
        createdAt: STARTED_AT,
        lastEffectiveActivityAt: STARTED_AT,
      });
      await transaction.insert(sessionQuestionSnapshots).values(
        Array.from({ length: 5 }, (_, index) => {
          const position = index + 1;
          return {
            id: `corrupt-interview:question:${position}`,
            interviewId: "corrupt-interview",
            position,
            sourceQuestionId: `bank-question-${position}`,
            sourceQuestionVersion: 1,
            domain: "go_language" as const,
            sourceWording: `Source question ${position}`,
            displayWording: `Displayed question ${position}`,
            rubric:
              position === 1 ? [] : (blueprint("corrupt").questions[index]?.question.rubric ?? []),
            followUpGoals: blueprint("corrupt").questions[index]?.question.followUpGoals ?? [],
            knowledgeExplanation: "Internal explanation",
            createdAt: STARTED_AT,
          };
        }),
      );
    });

    await expect(
      interviewRepository.findById(parseInterviewId("corrupt-interview")),
    ).rejects.toBeInstanceOf(RepositoryCorruptionError);
  });
});

function required<Value>(value: Value | undefined | null): Value {
  if (value === undefined || value === null) {
    throw new Error("Expected fixture value");
  }
  return value;
}
