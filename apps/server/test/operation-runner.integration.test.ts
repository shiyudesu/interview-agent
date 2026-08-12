import {
  PgInterviewRepository,
  PgOperationRepository,
  PgQuestionBankRepository,
  PgRepositoryUnitOfWork,
  type QuestionBankImportEntry,
  QuestionBankImportService,
  RepositoryIdempotencyConflictError,
  type StoredOperation,
  user,
} from "@interview-agent/db";
import {
  type AccountId,
  type AnswerEvaluationModel,
  type AnswerEvaluationRequest,
  type AnswerEvaluationResult,
  type InterviewerTextEvent,
  type InterviewerTextModel,
  type InterviewerTextRequest,
  KNOWLEDGE_DOMAINS,
  type ModelCallMetadata,
  parseAccountId,
  parseInterviewId,
  parseOperationId,
} from "@interview-agent/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  databaseNow,
  type PostgresTestDatabase,
  PostgresTestHarness,
} from "../../../packages/db/test/support/postgres-test-harness.js";
import { questionDefinitionFixture } from "../../../packages/db/test/support/question-definition-fixture.js";
import { AnswerEvaluationModelError } from "../src/answer-evaluation-model.js";
import { InterviewerTextModelError } from "../src/interviewer-text-model.js";
import { OperationEventBroker, type OperationEventPublisher } from "../src/operation-events.js";
import {
  InterviewOperationHandlers,
  OperationRunner,
  ServerOwnedOperationExecution,
} from "../src/operation-runner.js";
import { createCanonicalReadRouteDependencies } from "../src/read-routes.js";

const OWNER_ID = parseAccountId("operation-runner-owner");
const SECOND_OWNER_ID = parseAccountId("operation-runner-second-owner");
const MODEL_METADATA = {
  provider: "faux",
  modelId: "operation-runner-faux",
  promptVersion: "test-v1",
  schemaVersion: "test-v1",
  questionVersion: 1,
  purpose: "answer_evaluation",
  latencyMs: 1,
  inputTokens: 1,
  outputTokens: 1,
} as const satisfies ModelCallMetadata;

let harness: PostgresTestHarness;
let testDatabase: PostgresTestDatabase;
let unitOfWork: PgRepositoryUnitOfWork;
let interviewRepository: PgInterviewRepository;
let operationRepository: PgOperationRepository;
let evaluator: FauxAnswerEvaluationModel;
let interviewer: FauxInterviewerTextModel;
let handlers: InterviewOperationHandlers;
let operationEvents: OperationEventBroker;
let sequence = 0;

class FauxAnswerEvaluationModel implements AnswerEvaluationModel {
  implementation: (request: AnswerEvaluationRequest) => Promise<AnswerEvaluationResult> = async (
    request,
  ) => fullEvaluation(request);

  evaluate(request: AnswerEvaluationRequest): Promise<AnswerEvaluationResult> {
    return this.implementation(request);
  }
}

class FauxInterviewerTextModel implements InterviewerTextModel {
  readonly requests: InterviewerTextRequest[] = [];
  deltaText: string | undefined;
  implementation: (request: InterviewerTextRequest) => Promise<string> = async (request) =>
    request.purpose === "clarify_question"
      ? "请围绕当前问题说明它的适用边界。"
      : "请进一步说明这个机制在实际调用链中的影响。";

  async *stream(request: InterviewerTextRequest): AsyncIterable<InterviewerTextEvent> {
    this.requests.push(request);
    const text = await this.implementation(request);
    yield { type: "delta", text: this.deltaText ?? text };
    yield {
      type: "completed",
      text,
      metadata: {
        ...MODEL_METADATA,
        purpose: request.purpose,
        questionVersion: request.question.questionVersion,
      },
    };
  }
}

describe.sequential("persisted OperationRunner", () => {
  beforeAll(async () => {
    harness = await PostgresTestHarness.start();
    testDatabase = await harness.createDatabase({ name: "operation_runner_tests" });
    unitOfWork = new PgRepositoryUnitOfWork(testDatabase.client.database);
    interviewRepository = new PgInterviewRepository(testDatabase.client.database);
    operationRepository = new PgOperationRepository(testDatabase.client.database);
  }, 120_000);

  beforeEach(async () => {
    sequence = 0;
    await testDatabase.pool.query(
      `truncate table "user", question_bank_versions restart identity cascade`,
    );
    await testDatabase.client.database.insert(user).values([
      {
        id: OWNER_ID,
        name: "Operation Runner Owner",
        email: "operation-runner@example.com",
      },
      {
        id: SECOND_OWNER_ID,
        name: "Operation Runner Second Owner",
        email: "operation-runner-second@example.com",
      },
    ]);
    await seedQuestionBank();
    evaluator = new FauxAnswerEvaluationModel();
    interviewer = new FauxInterviewerTextModel();
    operationEvents = new OperationEventBroker();
    handlers = createHandlers(evaluator, interviewer, "operation-runner-worker", operationEvents);
  });

  afterAll(async () => {
    await harness?.stop();
  });

  it("creates atomically, returns canonical duplicates, and serializes competing versions", async () => {
    const interviewId = parseInterviewId("runner-create-idempotent");
    const first = await handlers.createInterview({
      ...commandInput(OWNER_ID, interviewId, "create-first", "create-key", 0),
      questionCount: 5,
    });
    const duplicate = await handlers.createInterview({
      ...commandInput(
        OWNER_ID,
        parseInterviewId("runner-create-duplicate"),
        "create-duplicate",
        "create-key",
        0,
      ),
      questionCount: 5,
    });

    expect(first).toMatchObject({ status: "succeeded", expectedVersion: 0 });
    expect(first.input).toMatchObject({
      questionCount: 5,
      selectionSeed: expect.any(String),
      questions: expect.arrayContaining([
        expect.objectContaining({
          position: 1,
          questionId: expect.any(String),
          questionVersion: 1,
        }),
      ]),
    });
    expect(duplicate).toEqual(first);
    expect(
      await interviewRepository.findById(parseInterviewId("runner-create-duplicate"), OWNER_ID),
    ).toBeNull();

    const competing = await Promise.all([
      handlers.submitAnswer({
        ...commandInput(OWNER_ID, interviewId, "competing-answer", "answer-key", 1),
        text: "Context 会沿派生链传播取消信号。",
      }),
      handlers.requestQuestionClarification(
        commandInput(OWNER_ID, interviewId, "competing-clarify", "clarify-key", 1),
      ),
    ]);
    expect(competing.filter((operation) => operation.status === "succeeded")).toHaveLength(1);
    expect(competing.filter((operation) => operation.status === "failed")).toHaveLength(1);
    expect(competing.find((operation) => operation.status === "failed")).toMatchObject({
      error: { classification: "version_conflict" },
    });
    expect((await interviewRepository.findById(interviewId, OWNER_ID))?.version).toBe(2);
  });

  it("rejects cross-command reuse of an existing idempotency key", async () => {
    const suffix = "runner-cross-command-idempotency";
    const interviewId = await createInterview(suffix);

    await expect(
      handlers.skip({
        ...commandInput(
          OWNER_ID,
          interviewId,
          "cross-command-operation",
          `${suffix}-create-key`,
          1,
        ),
      }),
    ).rejects.toBeInstanceOf(RepositoryIdempotencyConflictError);
  });

  it("persists a recoverable pending creation Operation before finalization", async () => {
    const interviewId = parseInterviewId("runner-create-recoverable");
    await testDatabase.pool.query(
      `alter table operations
         add constraint injected_creation_finalization_failure
         check (status = 'pending') not valid`,
    );
    try {
      await expect(
        handlers.createInterview({
          ...commandInput(OWNER_ID, interviewId, "create-recoverable", "create-recoverable-key", 0),
          questionCount: 5,
        }),
      ).rejects.toThrow();
    } finally {
      await testDatabase.pool.query(
        `alter table operations
           drop constraint injected_creation_finalization_failure`,
      );
    }
    const pending = await operationRepository.findById(
      parseOperationId("create-recoverable"),
      OWNER_ID,
    );
    expect(pending).toMatchObject({ status: "pending", type: "create_interview" });
    expect(await interviewRepository.findById(interviewId, OWNER_ID)).not.toBeNull();
    await expect(
      createCanonicalReadRouteDependencies(unitOfWork).activeInterview(OWNER_ID),
    ).resolves.toMatchObject({
      id: interviewId,
      phase: "awaiting_response",
      operation: {
        operationId: pending?.id,
        status: "pending",
      },
      availableActions: [],
    });
    await expect(
      handlers.submitAnswer({
        ...commandInput(
          OWNER_ID,
          interviewId,
          "blocked-before-create-finalization",
          "blocked-before-create-finalization-key",
          1,
        ),
        text: "创建 Operation 完成前不能推进面试。",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      retryable: false,
      error: {
        classification: "command_rejected",
        message: "Interview creation is still finalizing",
      },
    });

    await expect(
      handlers.createInterview({
        ...commandInput(
          OWNER_ID,
          parseInterviewId("ignored-duplicate-interview"),
          "ignored-duplicate-operation",
          "create-recoverable-key",
          0,
        ),
        questionCount: 5,
      }),
    ).resolves.toMatchObject({ id: pending?.id, status: "succeeded" });
  });

  it("serializes concurrent duplicate creation on the account lock", async () => {
    const calls = await Promise.all([
      handlers.createInterview({
        ...commandInput(
          OWNER_ID,
          parseInterviewId("concurrent-create-first"),
          "concurrent-create-operation-first",
          "concurrent-create-key",
          0,
        ),
        questionCount: 5,
      }),
      handlers.createInterview({
        ...commandInput(
          OWNER_ID,
          parseInterviewId("concurrent-create-second"),
          "concurrent-create-operation-second",
          "concurrent-create-key",
          0,
        ),
        questionCount: 5,
      }),
    ]);

    expect(new Set(calls.map(({ id }) => id))).toHaveLength(1);
    const canonical = await handlers.createInterview({
      ...commandInput(
        OWNER_ID,
        parseInterviewId("concurrent-create-third"),
        "concurrent-create-operation-third",
        "concurrent-create-key",
        0,
      ),
      questionCount: 5,
    });
    expect(canonical).toMatchObject({ id: calls[0]?.id, status: "succeeded" });
    expect(
      await interviewRepository.findById(parseInterviewId("concurrent-create-second"), OWNER_ID),
    ).toBeNull();
  });

  it("rolls back model facts on failure and retries unchanged immutable input", async () => {
    const interviewId = await createInterview("runner-failure");
    evaluator.implementation = async () => {
      throw new AnswerEvaluationModelError("transient_provider_failure", [], MODEL_METADATA);
    };
    const failed = await handlers.submitAnswer({
      ...commandInput(OWNER_ID, interviewId, "failed-answer", "failed-answer-key", 1),
      text: "原始答案内容不会在失败时落库。",
    });

    expect(failed).toMatchObject({
      status: "failed",
      retryable: true,
      attemptCount: 1,
      error: { code: "model_failure", retryable: true },
    });
    const cancelled = await requiredInterview(interviewId, OWNER_ID);
    expect(cancelled).toMatchObject({
      version: 2,
      phase: "awaiting_response",
      pendingOperation: null,
    });
    expect(cancelled.questions[0]?.answerMaterial).toEqual([]);
    expect(cancelled.questions[0]?.evaluation).toBeNull();
    await expect(
      handlers.submitAnswer({
        ...commandInput(OWNER_ID, interviewId, "failed-answer-duplicate", "failed-answer-key", 1),
        text: "原始答案内容不会在失败时落库。",
      }),
    ).resolves.toEqual(failed);

    evaluator.implementation = async (request) => fullEvaluation(request);
    const retried = await handlers.retry({
      ...retryInput(
        OWNER_ID,
        interviewId,
        "retry-failed-answer",
        "retry-failed-answer-key",
        failed.id,
        2,
      ),
    });
    expect(retried).toMatchObject({
      status: "succeeded",
      type: "retry_operation",
      attemptCount: 1,
      result: {
        targetOperationId: failed.id,
        targetOperationStatus: "succeeded",
      },
    });
    expect(retried.input).toEqual({ targetOperationId: failed.id });
    const retriedTarget = await operationRepository.findById(failed.id, OWNER_ID);
    expect(retriedTarget).toMatchObject({ status: "succeeded", attemptCount: 2 });
    expect(retriedTarget?.input).toEqual({
      questionPosition: 1,
      text: "原始答案内容不会在失败时落库。",
    });
    const completed = await requiredInterview(interviewId, OWNER_ID);
    expect(completed).toMatchObject({ version: 2, phase: "awaiting_continue" });
    expect(completed.questions[0]?.answerMaterial).toHaveLength(1);
    expect(completed.questions[0]?.evaluation).not.toBeNull();
    await expect(
      handlers.submitAnswer({
        ...commandInput(
          OWNER_ID,
          interviewId,
          "succeeded-answer-duplicate",
          "failed-answer-key",
          1,
        ),
        text: "原始答案内容不会在失败时落库。",
      }),
    ).resolves.toEqual(retriedTarget);
    await expect(
      handlers.retry({
        ...retryInput(
          OWNER_ID,
          interviewId,
          "retry-failed-answer-duplicate",
          "retry-failed-answer-key",
          failed.id,
          2,
        ),
      }),
    ).resolves.toEqual(retried);
    await expect(
      handlers.retry({
        ...retryInput(
          SECOND_OWNER_ID,
          interviewId,
          "retry-wrong-owner",
          "retry-wrong-owner-key",
          failed.id,
          2,
        ),
      }),
    ).rejects.toThrow();
  });

  it("keeps a retryable model failure visible after a newer rejected command", async () => {
    const interviewId = await createInterview("runner-readable-model-failure");
    evaluator.implementation = async () => {
      throw new AnswerEvaluationModelError("transient_provider_failure", [], MODEL_METADATA);
    };
    const failed = await handlers.submitAnswer({
      ...commandInput(
        OWNER_ID,
        interviewId,
        "readable-model-failure",
        "readable-model-failure-key",
        1,
      ),
      text: "这个回答会触发模型失败。",
    });
    await handlers.skip({
      ...commandInput(
        OWNER_ID,
        interviewId,
        "newer-version-conflict",
        "newer-version-conflict-key",
        1,
      ),
    });

    await expect(
      createCanonicalReadRouteDependencies(unitOfWork).interviewDetail(OWNER_ID, interviewId),
    ).resolves.toMatchObject({
      operation: {
        operationId: failed.id,
        status: "failed",
        failure: {
          retryable: true,
        },
      },
      availableActions: expect.arrayContaining(["retry"]),
    });
  });

  it("returns canonical post-expiry reads on the first request", async () => {
    const interviewId = await createInterview("runner-canonical-expiry");
    await testDatabase.pool.query(
      `update interview_sessions
          set created_at = statement_timestamp() - interval '26 hours',
              last_effective_activity_at = statement_timestamp() - interval '25 hours'
        where id = $1`,
      [interviewId],
    );
    const reads = createCanonicalReadRouteDependencies(unitOfWork);

    await expect(reads.activeInterview(OWNER_ID)).resolves.toBeNull();
    await expect(reads.interviewDetail(OWNER_ID, interviewId)).resolves.toMatchObject({
      id: interviewId,
      status: "abandoned",
      messages: [
        expect.objectContaining({
          kind: "main_question",
          role: "interviewer",
        }),
      ],
    });
  });

  it("classifies stale retry versions as canonical version conflicts", async () => {
    const interviewId = await createInterview("runner-retry-version-conflict");
    evaluator.implementation = async () => {
      throw new AnswerEvaluationModelError("transient_provider_failure", [], MODEL_METADATA);
    };
    const failed = await handlers.submitAnswer({
      ...commandInput(
        OWNER_ID,
        interviewId,
        "retry-version-conflict-target",
        "retry-version-conflict-target-key",
        1,
      ),
      text: "这个回答会产生可重试失败。",
    });

    const retry = await handlers.retry({
      ...retryInput(
        OWNER_ID,
        interviewId,
        "retry-version-conflict-command",
        "retry-version-conflict-command-key",
        failed.id,
        1,
      ),
    });

    expect(retry).toMatchObject({
      status: "failed",
      retryable: false,
      error: {
        classification: "version_conflict",
      },
    });
    expect(await operationRepository.findById(failed.id, OWNER_ID)).toEqual(failed);
  });

  it("retries clarification without changing the original request time", async () => {
    const interviewId = await createInterview("runner-clarification-retry");
    interviewer.implementation = async () => {
      throw new InterviewerTextModelError("model_call_failed", MODEL_METADATA);
    };
    const originalOccurredAt = await databaseNow(testDatabase);
    const failed = await handlers.requestQuestionClarification({
      accountId: OWNER_ID,
      interviewId,
      operationId: parseOperationId("clarification-retry-target"),
      idempotencyKey: "clarification-retry-target-key",
      expectedVersion: 1,
      occurredAt: originalOccurredAt,
    });
    expect(failed).toMatchObject({ status: "failed", retryable: true });

    interviewer.implementation = async () => "这个问题关注当前机制的适用边界。";
    const retried = await handlers.retry({
      ...retryInput(
        OWNER_ID,
        interviewId,
        "clarification-retry-command",
        "clarification-retry-command-key",
        failed.id,
        2,
      ),
    });

    expect(retried).toMatchObject({ status: "succeeded", type: "retry_operation" });
    expect(operationEvents.history(failed)).toMatchObject([
      {
        sequence: 1,
        type: "text_delta",
        text: "这个问题关注当前机制的适用边界。",
      },
      {
        sequence: 2,
        type: "succeeded",
      },
    ]);
    expect(operationEvents.history(retried)).toMatchObject([
      {
        sequence: 1,
        type: "text_delta",
        text: "这个问题关注当前机制的适用边界。",
      },
      {
        sequence: 2,
        type: "succeeded",
      },
    ]);
    const interview = await requiredInterview(interviewId, OWNER_ID);
    expect(interview.questions[0]?.questionClarifications).toEqual([
      expect.objectContaining({
        requestedAt: originalOccurredAt,
      }),
    ]);
  });

  it("replays pending retries by canonical ID and reclaims stale retry commands", async () => {
    const interviewId = await createInterview("runner-retry-command-recovery");
    evaluator.implementation = async () => {
      throw new AnswerEvaluationModelError("transient_provider_failure", [], MODEL_METADATA);
    };
    const target = await handlers.submitAnswer({
      ...commandInput(OWNER_ID, interviewId, "retry-command-target", "retry-command-target-key", 1),
      text: "需要通过 retry Operation 恢复。",
    });
    expect(target).toMatchObject({ status: "failed", retryable: true });
    evaluator.implementation = async (request) => fullEvaluation(request);

    const retryId = parseOperationId("persisted-retry-command");
    const retryKey = "persisted-retry-command-key";
    const createdRetry = await operationRepository.createOrLoad({
      id: retryId,
      accountId: OWNER_ID,
      interviewId,
      idempotencyScope: "interview-command",
      type: "retry_operation",
      idempotencyKey: retryKey,
      expectedVersion: 2,
      input: { targetOperationId: String(target.id) },
      createdAt: await databaseNow(testDatabase),
    });
    const claimedRetry = await operationRepository.claimPending({
      operationId: createdRetry.operation.id,
      accountId: OWNER_ID,
      leaseOwner: "crashed-retry-worker",
      leaseDurationMs: 30_000,
    });
    expect(claimedRetry).not.toBeNull();
    await testDatabase.pool.query(
      `update operations
          set lease_acquired_at = statement_timestamp() - interval '2 minutes',
              lease_expires_at = statement_timestamp() - interval '1 minute'
        where id = $1`,
      [retryId],
    );

    const recovered = await handlers.retry({
      ...retryInput(OWNER_ID, interviewId, "ignored-retry-replay-id", retryKey, target.id, 2),
    });

    expect(recovered).toMatchObject({
      id: retryId,
      status: "succeeded",
      attemptCount: 2,
      result: { targetOperationId: target.id },
    });
  });

  it("uses one lease deadline for retry and target Operations", async () => {
    const interviewId = await createInterview("runner-shared-retry-lease");
    evaluator.implementation = async () => {
      throw new AnswerEvaluationModelError("transient_provider_failure", [], MODEL_METADATA);
    };
    const target = await handlers.submitAnswer({
      ...commandInput(OWNER_ID, interviewId, "shared-lease-target", "shared-lease-target-key", 1),
      text: "第一次调用失败，retry 会共享租约截止时间。",
    });
    let release: (() => void) | undefined;
    evaluator.implementation = (request) =>
      new Promise<AnswerEvaluationResult>((resolve) => {
        release = () => resolve(fullEvaluation(request));
      });
    const retryOperationId = parseOperationId("shared-lease-retry");
    const retryPromise = handlers.retry({
      ...retryInput(
        OWNER_ID,
        interviewId,
        retryOperationId,
        "shared-lease-retry-key",
        target.id,
        2,
      ),
    });
    await waitForOperation(target.id, "processing");
    await waitForOperation(retryOperationId, "processing");
    const leaseRows = await testDatabase.pool.query<{
      id: string;
      lease_expires_at: Date;
    }>(
      `select id, lease_expires_at
         from operations
        where id = any($1::text[])
        order by id`,
      [[target.id, retryOperationId]],
    );
    expect(leaseRows.rows).toHaveLength(2);
    expect(leaseRows.rows[0]?.lease_expires_at).toEqual(leaseRows.rows[1]?.lease_expires_at);
    release?.();
    await expect(retryPromise).resolves.toMatchObject({ status: "succeeded" });
  });

  it("keeps retry command failures terminal while the target remains retryable", async () => {
    const interviewId = await createInterview("runner-retry-failure-payload");
    evaluator.implementation = async () => {
      throw new AnswerEvaluationModelError("transient_provider_failure", [], MODEL_METADATA);
    };
    const target = await handlers.submitAnswer({
      ...commandInput(OWNER_ID, interviewId, "retry-failure-target", "retry-failure-target-key", 1),
      text: "目标 Operation 会再次失败。",
    });
    const retry = await handlers.retry({
      ...retryInput(
        OWNER_ID,
        interviewId,
        "retry-failure-command",
        "retry-failure-command-key",
        target.id,
        2,
      ),
    });

    expect(retry).toMatchObject({
      status: "failed",
      retryable: false,
      error: { retryable: false },
    });
    expect(await operationRepository.findById(target.id, OWNER_ID)).toMatchObject({
      status: "failed",
      retryable: true,
      error: { retryable: true },
    });
    expect(operationEvents.history(target)).toMatchObject([
      {
        sequence: 1,
        type: "failed",
        failure: { code: "model_failure", retryable: true },
      },
    ]);
    expect(operationEvents.history(retry)).toEqual([]);
    await expect(
      createCanonicalReadRouteDependencies(unitOfWork).interviewDetail(OWNER_ID, interviewId),
    ).resolves.toMatchObject({
      operation: {
        operationId: target.id,
        status: "failed",
        failure: {
          retryable: true,
        },
      },
      availableActions: expect.arrayContaining(["retry"]),
    });
  });

  it("terminally fails a pending retry command after concurrent abandonment", async () => {
    const interviewId = await createInterview("runner-retry-abandon-race");
    evaluator.implementation = async () => {
      throw new AnswerEvaluationModelError("transient_provider_failure", [], MODEL_METADATA);
    };
    const target = await handlers.submitAnswer({
      ...commandInput(OWNER_ID, interviewId, "retry-abandon-target", "retry-abandon-target-key", 1),
      text: "目标先失败，再模拟 retry 与 abandon 竞争。",
    });
    const retryId = parseOperationId("retry-abandon-command");
    const retryKey = "retry-abandon-command-key";
    await operationRepository.createOrLoad({
      id: retryId,
      accountId: OWNER_ID,
      interviewId,
      idempotencyScope: "interview-command",
      type: "retry_operation",
      idempotencyKey: retryKey,
      expectedVersion: 2,
      input: { targetOperationId: String(target.id) },
      createdAt: await databaseNow(testDatabase),
    });
    await handlers.abandon(
      commandInput(
        OWNER_ID,
        interviewId,
        "retry-abandon-terminal",
        "retry-abandon-terminal-key",
        2,
      ),
    );

    const rejected = await handlers.retry({
      ...retryInput(OWNER_ID, interviewId, "ignored-retry-abandon-id", retryKey, target.id, 2),
    });
    expect(rejected).toMatchObject({
      id: retryId,
      status: "failed",
      retryable: false,
      error: { retryable: false },
    });
  });

  it("reclaims stale processing and continues independently of the initiating caller", async () => {
    const interviewId = await createInterview("runner-stale");
    let releaseEvaluation: ((result: AnswerEvaluationResult) => void) | undefined;
    let deferredRequest: AnswerEvaluationRequest | undefined;
    evaluator.implementation = (request) =>
      new Promise<AnswerEvaluationResult>((resolve) => {
        deferredRequest = request;
        releaseEvaluation = (result) => resolve(result);
      });

    const detached = new ServerOwnedOperationExecution().execute(() =>
      handlers.submitAnswer({
        ...commandInput(OWNER_ID, interviewId, "stale-answer", "stale-answer-key", 1),
        text: "即使调用方不再等待，服务端执行仍由持久化 Operation 驱动。",
      }),
    );
    const processing = await waitForOperation("stale-answer", "processing");
    await expect(
      handlers.submitAnswer({
        ...commandInput(OWNER_ID, interviewId, "stale-answer-duplicate", "stale-answer-key", 1),
        text: "即使调用方不再等待，服务端执行仍由持久化 Operation 驱动。",
      }),
    ).resolves.toEqual(processing);
    await testDatabase.pool.query(
      `update operations
          set lease_acquired_at = statement_timestamp() - interval '2 minutes',
              lease_expires_at = statement_timestamp() - interval '1 minute'
        where id = $1`,
      [processing.id],
    );

    const retryEvaluator = new FauxAnswerEvaluationModel();
    const retryHandlers = createHandlers(
      retryEvaluator,
      interviewer,
      "operation-runner-retry-worker",
    );
    const reclaimed = await retryHandlers.retry({
      ...retryInput(
        OWNER_ID,
        interviewId,
        "retry-stale-answer",
        "retry-stale-answer-key",
        processing.id,
        2,
      ),
    });
    expect(reclaimed).toMatchObject({
      status: "succeeded",
      type: "retry_operation",
      result: { targetOperationId: processing.id },
    });
    expect(await operationRepository.findById(processing.id, OWNER_ID)).toMatchObject({
      status: "succeeded",
      attemptCount: 2,
    });

    if (deferredRequest === undefined) {
      throw new Error("Deferred evaluator was not called");
    }
    releaseEvaluation?.(fullEvaluation(deferredRequest));
    await expect(detached).rejects.toThrow();
    expect(
      (await requiredInterview(interviewId, OWNER_ID)).questions[0]?.answerMaterial,
    ).toHaveLength(1);
  });

  it("rolls back both success and failure finalization when aggregate persistence fails", async () => {
    const successInterviewId = await createInterview("runner-success-rollback");
    await testDatabase.pool.query(
      `alter table question_evaluations
         add constraint injected_operation_runner_evaluation_failure
         check (false) not valid`,
    );
    try {
      await expect(
        handlers.submitAnswer({
          ...commandInput(
            OWNER_ID,
            successInterviewId,
            "success-rollback-answer",
            "success-rollback-key",
            1,
          ),
          text: "该答案会通过模型，但持久化被测试约束拒绝。",
        }),
      ).rejects.toThrow();
    } finally {
      await testDatabase.pool.query(
        `alter table question_evaluations
           drop constraint injected_operation_runner_evaluation_failure`,
      );
    }
    expect(
      await operationRepository.findById(parseOperationId("success-rollback-answer"), OWNER_ID),
    ).toMatchObject({ status: "processing", result: null });
    expect(await requiredInterview(successInterviewId, OWNER_ID)).toMatchObject({
      version: 2,
      phase: "processing",
    });

    const failureOwner = SECOND_OWNER_ID;
    const failureInterviewId = await createInterview("runner-failure-rollback", failureOwner);
    const failureEvaluator = new FauxAnswerEvaluationModel();
    failureEvaluator.implementation = async () => {
      throw new AnswerEvaluationModelError("transient_provider_failure", [], MODEL_METADATA);
    };
    const failureHandlers = createHandlers(
      failureEvaluator,
      interviewer,
      "operation-runner-failure-worker",
    );
    await testDatabase.pool.query(
      `alter table interview_sessions
         add constraint injected_operation_runner_cancellation_failure
         check (active_phase = 'processing') not valid`,
    );
    try {
      await expect(
        failureHandlers.submitAnswer({
          ...commandInput(
            failureOwner,
            failureInterviewId,
            "failure-rollback-answer",
            "failure-rollback-key",
            1,
          ),
          text: "模型失败后的取消持久化也必须与 Operation 失败原子提交。",
        }),
      ).rejects.toThrow();
    } finally {
      await testDatabase.pool.query(
        `alter table interview_sessions
           drop constraint injected_operation_runner_cancellation_failure`,
      );
    }
    expect(
      await operationRepository.findById(parseOperationId("failure-rollback-answer"), failureOwner),
    ).toMatchObject({ status: "processing", error: null });
    expect(await requiredInterview(failureInterviewId, failureOwner)).toMatchObject({
      version: 2,
      phase: "processing",
    });
  });

  it("runs clarification, selected-goal follow-up, evaluation, supplement, and continue handlers", async () => {
    const interviewId = await createInterview("runner-model-flow");
    interviewer.deltaText = "不得在完整校验前释放的片段。";
    const clarification = await handlers.requestQuestionClarification(
      commandInput(OWNER_ID, interviewId, "clarification", "clarification-key", 1),
    );
    expect(clarification).toMatchObject({ status: "succeeded" });
    expect(operationEvents.history(clarification)).toMatchObject([
      {
        sequence: 1,
        type: "text_delta",
        text: "请围绕当前问题说明它的适用边界。",
      },
      {
        sequence: 2,
        type: "succeeded",
      },
    ]);
    expect(JSON.stringify(operationEvents.history(clarification))).not.toContain(
      "不得在完整校验前释放",
    );

    evaluator.implementation = async (request) => followUpEvaluation(request);
    await expect(
      handlers.submitAnswer({
        ...commandInput(OWNER_ID, interviewId, "main-answer", "main-answer-key", 2),
        text: "取消信号会传播。",
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(interviewer.requests.map((request) => request.purpose)).toEqual([
      "clarify_question",
      "phrase_follow_up",
    ]);

    evaluator.implementation = async (request) => fullEvaluation(request);
    await handlers.submitAnswer({
      ...commandInput(OWNER_ID, interviewId, "follow-up-answer", "follow-up-answer-key", 3),
      text: "调用方监听 Done 并停止 goroutine。",
    });

    await handlers.submitSupplement({
      ...commandInput(OWNER_ID, interviewId, "supplement", "supplement-key", 4),
      text: "补充说明还需要释放相关资源。",
    });
    const beforeContinue = await requiredInterview(interviewId, OWNER_ID);
    expect(beforeContinue).toMatchObject({ version: 5, phase: "awaiting_continue" });
    expect(beforeContinue.questions[0]?.answerMaterial.map((item) => item.kind)).toEqual([
      "main_answer",
      "follow_up_answer",
      "supplement",
    ]);

    await handlers.continueInterview(
      commandInput(OWNER_ID, interviewId, "continue", "continue-key", 5),
    );
    expect(await requiredInterview(interviewId, OWNER_ID)).toMatchObject({
      version: 6,
      phase: "awaiting_response",
      currentQuestionPosition: 2,
    });
  });

  it("keeps committed commands successful when auxiliary event publication fails", async () => {
    const interviewId = await createInterview("runner-event-publication-failure");
    const fail = () => {
      throw new Error("event broker unavailable");
    };
    const publishingHandlers = createHandlers(
      evaluator,
      interviewer,
      "operation-runner-event-failure-worker",
      {
        beginAttempt: fail,
        publishTextDelta: fail,
        publishTextAndTerminal: fail,
        publishTerminal: fail,
      },
    );

    await expect(
      publishingHandlers.requestQuestionClarification(
        commandInput(
          OWNER_ID,
          interviewId,
          "event-publication-failure",
          "event-publication-failure-key",
          1,
        ),
      ),
    ).resolves.toMatchObject({ status: "succeeded" });
    const persisted = await requiredInterview(interviewId, OWNER_ID);
    expect(persisted).toMatchObject({
      version: 2,
      phase: "awaiting_response",
    });
    expect(persisted.questions[0]?.questionClarifications).toHaveLength(1);
  });

  it("persists unknown, skip, continue, early-end, and abandon transitions atomically", async () => {
    const interviewId = await createInterview("runner-immediate");
    await handlers.markUnknown(commandInput(OWNER_ID, interviewId, "unknown", "unknown-key", 1));
    await handlers.continueInterview(
      commandInput(OWNER_ID, interviewId, "continue-unknown", "continue-unknown-key", 2),
    );
    await handlers.skip(commandInput(OWNER_ID, interviewId, "skip", "skip-key", 3));
    const earlyEnd = await handlers.endEarly(
      commandInput(OWNER_ID, interviewId, "early-end", "early-end-key", 4),
    );
    expect(earlyEnd).toMatchObject({ status: "succeeded" });
    expect(await requiredInterview(interviewId, OWNER_ID)).toMatchObject({
      version: 5,
      status: "report_pending",
      pendingReportKind: "incomplete",
    });

    const abandonedInterviewId = await createInterview("runner-abandon", SECOND_OWNER_ID);
    const abandoned = await handlers.abandon(
      commandInput(SECOND_OWNER_ID, abandonedInterviewId, "abandon", "abandon-key", 1),
    );
    expect(abandoned).toMatchObject({ status: "succeeded" });
    expect(await requiredInterview(abandonedInterviewId, SECOND_OWNER_ID)).toMatchObject({
      version: 2,
      status: "abandoned",
      phase: null,
    });
  });
});

function createHandlers(
  answerModel: AnswerEvaluationModel,
  textModel: InterviewerTextModel,
  leaseOwner: string,
  events?: OperationEventPublisher,
): InterviewOperationHandlers {
  return new InterviewOperationHandlers(
    new OperationRunner(unitOfWork, textModel, answerModel, {
      leaseOwner,
      leaseDurationMs: 5 * 60_000,
      ...(events === undefined ? {} : { events }),
    }),
  );
}

async function createInterview(
  suffix: string,
  accountId: AccountId = OWNER_ID,
): Promise<ReturnType<typeof parseInterviewId>> {
  const interviewId = parseInterviewId(`${suffix}-interview`);
  const operation = await handlers.createInterview({
    ...commandInput(accountId, interviewId, `${suffix}-create`, `${suffix}-create-key`, 0),
    questionCount: 5,
  });
  expect(operation.status).toBe("succeeded");
  return interviewId;
}

function commandInput(
  accountId: AccountId,
  interviewId: ReturnType<typeof parseInterviewId>,
  operation: string,
  idempotencyKey: string,
  expectedVersion: number,
) {
  sequence += 1;
  return {
    accountId,
    interviewId,
    operationId: parseOperationId(operation),
    idempotencyKey,
    expectedVersion,
    occurredAt: new Date(Date.now() + sequence),
  };
}

function retryInput(
  accountId: AccountId,
  interviewId: ReturnType<typeof parseInterviewId>,
  operation: string,
  idempotencyKey: string,
  targetOperationId: ReturnType<typeof parseOperationId>,
  expectedVersion: number,
) {
  sequence += 1;
  return {
    accountId,
    interviewId,
    operationId: parseOperationId(operation),
    targetOperationId,
    idempotencyKey,
    expectedVersion,
    occurredAt: new Date(Date.now() + sequence),
  };
}

function fullEvaluation(request: AnswerEvaluationRequest): AnswerEvaluationResult {
  const evidence = request.answerMaterial.at(-1)?.id;
  return {
    classification: "relevant",
    rubricItems: request.question.rubric.map((item) => ({
      rubricItemId: item.id,
      evidenceMaterialIds: evidence === undefined ? [] : [evidence],
      awardedPoints: item.weight,
      missingOrIncorrectPoints: [],
    })),
    recommendedFollowUpGoal: null,
    metadata: {
      ...MODEL_METADATA,
      questionVersion: request.question.questionVersion,
    },
  };
}

function followUpEvaluation(request: AnswerEvaluationRequest): AnswerEvaluationResult {
  const goal = request.question.followUpGoals.find(
    (candidate) => candidate.kind === "clarification",
  );
  if (goal === undefined) {
    throw new Error("Fixture question has no clarification goal");
  }
  return {
    ...fullEvaluation(request),
    recommendedFollowUpGoal: {
      goalId: goal.id,
      kind: goal.kind,
      purpose: "answer_clarification",
    },
  };
}

async function requiredInterview(
  interviewId: ReturnType<typeof parseInterviewId>,
  accountId: AccountId,
) {
  const interview = await interviewRepository.findById(interviewId, accountId);
  if (interview === null) {
    throw new Error(`Missing interview ${interviewId}`);
  }
  return interview;
}

async function waitForOperation(
  operationId: string,
  status: StoredOperation["status"],
): Promise<StoredOperation> {
  const id = parseOperationId(operationId);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const operation = await operationRepository.findById(id, OWNER_ID);
    if (operation?.status === status) {
      return operation;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Operation ${operationId} did not reach ${status}`);
}

async function seedQuestionBank(): Promise<void> {
  const entries: QuestionBankImportEntry[] = KNOWLEDGE_DOMAINS.map((domain, index) => ({
    definition: questionDefinitionFixture({
      id: `runner.question.${index + 1}`,
      contentVersion: 1,
      domain,
      sourceWording: `请说明第 ${index + 1} 个 Go 后端主题中的核心机制和适用边界。`,
    }),
    schemaVersion: "1.0",
    sourceFile: `${domain}/questions.yaml`,
  }));
  await new QuestionBankImportService(
    new PgQuestionBankRepository(testDatabase.client.database),
  ).synchronize({
    sourceName: "operation-runner-fixture",
    sourceVersion: 1,
    entries,
  });
}
