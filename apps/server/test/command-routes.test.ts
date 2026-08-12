import {
  ActiveInterviewExistsError,
  RepositoryIdempotencyConflictError,
  RepositoryInterviewExpiredError,
  RepositoryInterviewUnavailableError,
  RepositoryNotFoundError,
  RepositoryOperationRetryConflictError,
  RepositoryVersionConflictError,
  type StoredOperation,
} from "@interview-agent/db";
import { parseAccountId, parseInterviewId, parseOperationId } from "@interview-agent/domain";
import type { BetterAuthOptions } from "better-auth";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerApplication } from "../src/app.js";
import type { AuthenticatedRequestContext, Authentication } from "../src/auth.js";
import type { InterviewCommandRouteDependencies } from "../src/command-routes.js";
import { DeletionOrchestrationService } from "../src/deletion.js";
import {
  OperationEventBroker,
  type OperationEventRouteDependencies,
} from "../src/operation-events.js";
import {
  type AcceptedOperationExecution,
  ServerOwnedOperationStarter,
  ServerOwnedOperationSupervisor,
} from "../src/operation-runner.js";
import type { CanonicalReadRouteDependencies } from "../src/read-routes.js";

const apps: ReturnType<typeof Fastify>[] = [];
const accountId = parseAccountId("command-route-owner");
const now = new Date("2026-08-12T03:00:00.000Z");
const authContext: AuthenticatedRequestContext = {
  accountId,
  sessionId: "session-1",
  email: "candidate@example.test",
  name: "Candidate",
};
const config = {
  auth: {
    secret: "0123456789abcdef0123456789abcdef",
    baseUrl: "http://localhost:3000",
  },
} as const;
type CommandResult = StoredOperation | AcceptedOperationExecution;

function authentication(context: AuthenticatedRequestContext | null = authContext): Authentication {
  const options: BetterAuthOptions = {};
  return {
    handler: async () => new Response(null, { status: 404 }),
    options,
    getSession: async () => ({ context, headers: new Headers() }),
  };
}

function deletion() {
  return new DeletionOrchestrationService({
    markInterviewDeleting: async () => null,
    markAccountDeleting: async () => null,
  });
}

function canonicalReads(): CanonicalReadRouteDependencies {
  const unavailable = async () => {
    throw new Error("Canonical read was not configured for this test");
  };
  return {
    currentAccount: unavailable,
    activeInterview: unavailable,
    interviewDetail: unavailable,
    operationStatus: unavailable,
    interviewHistory: unavailable,
    reportDetail: unavailable,
  };
}

function operationEvents(): OperationEventRouteDependencies {
  return {
    broker: new OperationEventBroker(),
    access: {
      findAccessible: async () => null,
    },
  };
}

function operation(
  input: {
    readonly accountId: typeof accountId;
    readonly interviewId: ReturnType<typeof parseInterviewId>;
    readonly operationId: ReturnType<typeof parseOperationId>;
    readonly idempotencyKey: string;
    readonly expectedVersion: number;
    readonly occurredAt: Date;
  },
  type: StoredOperation["type"],
  changes: Partial<StoredOperation> = {},
): StoredOperation {
  return {
    id: input.operationId,
    accountId: input.accountId,
    interviewId: input.interviewId,
    idempotencyScope: "interview-command",
    idempotencyKey: input.idempotencyKey,
    type,
    status: "succeeded",
    expectedVersion: input.expectedVersion,
    inputHash: "a".repeat(64),
    attemptCount: 1,
    lastAttemptAt: input.occurredAt,
    leaseAcquiredAt: null,
    leaseExpiresAt: null,
    leaseOwner: null,
    retryable: false,
    input: {},
    result: {
      interviewId: String(input.interviewId),
      interviewVersion: input.expectedVersion + 1,
      reportId: null,
    },
    error: null,
    createdAt: input.occurredAt,
    updatedAt: input.occurredAt,
    completedAt: input.occurredAt,
    ...changes,
  };
}

function commandDependencies(
  starter: InterviewCommandRouteDependencies["starter"] = { start: () => undefined },
) {
  let operationSequence = 0;
  const handlers = {
    createInterview: vi.fn(
      async (input): Promise<CommandResult> => operation(input, "create_interview"),
    ),
    submitAnswer: vi.fn(async (input): Promise<CommandResult> => operation(input, "submit_answer")),
    submitSupplement: vi.fn(
      async (input): Promise<CommandResult> => operation(input, "submit_supplement"),
    ),
    requestQuestionClarification: vi.fn(
      async (input): Promise<CommandResult> => operation(input, "request_question_clarification"),
    ),
    markUnknown: vi.fn(
      async (input): Promise<CommandResult> => operation(input, "mark_question_unknown"),
    ),
    skip: vi.fn(async (input): Promise<CommandResult> => operation(input, "skip_question")),
    continueInterview: vi.fn(
      async (input): Promise<CommandResult> => operation(input, "continue_interview"),
    ),
    endEarly: vi.fn(
      async (input): Promise<CommandResult> => operation(input, "end_interview_early"),
    ),
    abandon: vi.fn(async (input): Promise<CommandResult> => operation(input, "abandon_interview")),
    retry: vi.fn(async (input): Promise<CommandResult> => operation(input, "retry_operation")),
  } satisfies InterviewCommandRouteDependencies["handlers"];
  const dependencies: InterviewCommandRouteDependencies = {
    handlers,
    starter,
    states: {
      findById: async () => ({
        version: 3,
        status: "active",
        phase: "awaiting_response",
      }),
    },
    now: () => new Date(now),
    nextInterviewId: () => parseInterviewId("server-interview"),
    nextOperationId: () => {
      operationSequence += 1;
      return parseOperationId(`server-operation-${operationSequence}`);
    },
  };
  return { dependencies, handlers };
}

async function createApp(
  dependencies: InterviewCommandRouteDependencies,
  context: AuthenticatedRequestContext | null = authContext,
  authenticationOverride?: Authentication,
) {
  const instance = Fastify({ logger: false });
  apps.push(instance);
  await registerApplication(instance, {
    authentication: authenticationOverride ?? authentication(context),
    config,
    deletion: deletion(),
    interviewCommands: dependencies,
    canonicalReads: canonicalReads(),
    operationEvents: operationEvents(),
  });
  return instance;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((instance) => instance.close()));
});

describe("interview command routes", () => {
  it("routes every command through composed handlers with server-owned identifiers", async () => {
    const { dependencies, handlers } = commandDependencies();
    const instance = await createApp(dependencies);
    const cases = [
      {
        url: "/api/v1/interviews",
        payload: { questionCount: 5, expectedVersion: 0 },
        handler: handlers.createInterview,
        expected: { interviewId: "server-interview", questionCount: 5 },
      },
      {
        url: "/api/v1/interviews/interview-1/answers",
        payload: { expectedVersion: 3, text: "主回答" },
        handler: handlers.submitAnswer,
        expected: { interviewId: "interview-1", text: "主回答" },
      },
      {
        url: "/api/v1/interviews/interview-1/supplements",
        payload: { expectedVersion: 3, text: "补充回答" },
        handler: handlers.submitSupplement,
        expected: { interviewId: "interview-1", text: "补充回答" },
      },
      {
        url: "/api/v1/interviews/interview-1/clarifications",
        payload: { expectedVersion: 3 },
        handler: handlers.requestQuestionClarification,
        expected: { interviewId: "interview-1" },
      },
      {
        url: "/api/v1/interviews/interview-1/unknown",
        payload: { expectedVersion: 3 },
        handler: handlers.markUnknown,
        expected: { interviewId: "interview-1" },
      },
      {
        url: "/api/v1/interviews/interview-1/skip",
        payload: { expectedVersion: 3 },
        handler: handlers.skip,
        expected: { interviewId: "interview-1" },
      },
      {
        url: "/api/v1/interviews/interview-1/continue",
        payload: { expectedVersion: 3 },
        handler: handlers.continueInterview,
        expected: { interviewId: "interview-1" },
      },
      {
        url: "/api/v1/interviews/interview-1/end-early",
        payload: { expectedVersion: 3 },
        handler: handlers.endEarly,
        expected: { interviewId: "interview-1" },
      },
      {
        url: "/api/v1/interviews/interview-1/abandon",
        payload: { expectedVersion: 3 },
        handler: handlers.abandon,
        expected: { interviewId: "interview-1" },
      },
      {
        url: "/api/v1/interviews/interview-1/retry",
        payload: { expectedVersion: 3, operationId: "failed-operation" },
        handler: handlers.retry,
        expected: {
          interviewId: "interview-1",
          targetOperationId: "failed-operation",
        },
      },
    ] as const;

    for (const [index, testCase] of cases.entries()) {
      const response = await instance.inject({
        method: "POST",
        url: testCase.url,
        headers: { "idempotency-key": `command-key-${index}` },
        payload: testCase.payload,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        operationId: `server-operation-${index + 1}`,
        status: "succeeded",
        result: {
          interviewId: testCase.expected.interviewId,
          reportId: null,
        },
      });
      expect(testCase.handler).toHaveBeenLastCalledWith(
        expect.objectContaining({
          accountId,
          ...testCase.expected,
          operationId: parseOperationId(`server-operation-${index + 1}`),
          idempotencyKey: `command-key-${index}`,
          expectedVersion: testCase.payload.expectedVersion,
          occurredAt: now,
        }),
      );
    }
  });

  it("requires authentication, a valid Idempotency-Key, valid params, and expected versions", async () => {
    const { dependencies, handlers } = commandDependencies();
    const instance = await createApp(dependencies);
    const unauthenticated = await createApp(dependencies, null);
    const requests = [
      instance.inject({
        method: "POST",
        url: "/api/v1/interviews/interview-1/skip",
        payload: { expectedVersion: 3 },
      }),
      instance.inject({
        method: "POST",
        url: "/api/v1/interviews/interview-1/skip",
        headers: { "idempotency-key": "short" },
        payload: { expectedVersion: 3 },
      }),
      instance.inject({
        method: "POST",
        url: "/api/v1/interviews",
        headers: { "idempotency-key": "create-key" },
        payload: { questionCount: 5, expectedVersion: 1 },
      }),
      instance.inject({
        method: "POST",
        url: "/api/v1/interviews/interview-1/answers",
        headers: { "idempotency-key": "answer-key" },
        payload: { text: "回答" },
      }),
      instance.inject({
        method: "POST",
        url: "/api/v1/interviews/interview-1/answers",
        headers: { "idempotency-key": "version-overflow-key" },
        payload: { expectedVersion: 2_147_483_648, text: "回答" },
      }),
      instance.inject({
        method: "POST",
        url: "/api/v1/interviews/bad%20id/skip",
        headers: { "idempotency-key": "params-key" },
        payload: { expectedVersion: 3 },
      }),
    ];
    for (const request of requests) {
      const response = await request;
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: {
          code: "validation_error",
          message: "The request is invalid.",
        },
      });
    }

    const malformed = await instance.inject({
      method: "POST",
      url: "/api/v1/interviews/interview-1/skip",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "malformed-json-key",
      },
      payload: '{"expectedVersion":3',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({
      error: {
        code: "validation_error",
        message: "The request is invalid.",
      },
    });

    const unauthorized = await unauthenticated.inject({
      method: "POST",
      url: "/api/v1/interviews/interview-1/skip",
      headers: { "idempotency-key": "unauth-key" },
      payload: { expectedVersion: 3 },
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required",
      },
    });
    expect(handlers.skip).not.toHaveBeenCalled();
  });

  it("sanitizes plain authentication failures that have no Fastify error code", async () => {
    const { dependencies } = commandDependencies();
    const failingAuthentication = authentication();
    failingAuthentication.getSession = async () => {
      throw new Error("session database token=secret");
    };
    const instance = await createApp(dependencies, authContext, failingAuthentication);

    const response = await instance.inject({
      method: "POST",
      url: "/api/v1/interviews/interview-1/skip",
      headers: { "idempotency-key": "auth-failure-key" },
      payload: { expectedVersion: 3 },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: "internal_error",
        message: "An unexpected error occurred.",
      },
    });
    expect(response.body).not.toContain("secret");
  });

  it("returns durable pending and succeeded Operation projections with stable status codes", async () => {
    const { dependencies, handlers } = commandDependencies();
    handlers.skip.mockImplementationOnce(async (input) =>
      operation(input, "skip_question", {
        status: "processing",
        result: null,
        completedAt: null,
        leaseAcquiredAt: now,
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        leaseOwner: "worker-1",
      }),
    );
    const instance = await createApp(dependencies);

    const response = await instance.inject({
      method: "POST",
      url: "/api/v1/interviews/interview-1/skip",
      headers: { "idempotency-key": "processing-key" },
      payload: { expectedVersion: 3 },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      operationId: "server-operation-1",
      status: "processing",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
  });

  it("returns 202 before blocked server-owned work completes and starts a duplicate once", async () => {
    const { dependencies, handlers } = commandDependencies(new ServerOwnedOperationStarter());
    let canonical: StoredOperation | undefined;
    let releaseWork: (() => void) | undefined;
    let starts = 0;
    let finished = false;
    const workGate = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    handlers.submitAnswer.mockImplementation(async (input) => {
      if (canonical !== undefined) {
        return { operation: canonical, work: null };
      }
      canonical = operation(input, "submit_answer", {
        status: "processing",
        result: null,
        completedAt: null,
        leaseAcquiredAt: now,
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        leaseOwner: "worker-1",
      });
      const acceptedOperation = canonical;
      return {
        operation: acceptedOperation,
        work: {
          operationId: acceptedOperation.id,
          async start() {
            starts += 1;
            await workGate;
            finished = true;
            return { ...acceptedOperation, status: "succeeded", completedAt: now };
          },
        },
      };
    });
    const instance = await createApp(dependencies);

    const first = await instance.inject({
      method: "POST",
      url: "/api/v1/interviews/interview-1/answers",
      headers: { "idempotency-key": "blocked-answer-key" },
      payload: { expectedVersion: 3, text: "回答" },
    });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({
      operationId: "server-operation-1",
      status: "processing",
    });
    expect(starts).toBe(1);
    expect(finished).toBe(false);

    const duplicate = await instance.inject({
      method: "POST",
      url: "/api/v1/interviews/interview-1/answers",
      headers: { "idempotency-key": "blocked-answer-key" },
      payload: { expectedVersion: 3, text: "回答" },
    });
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json()).toEqual(first.json());
    expect(starts).toBe(1);

    releaseWork?.();
    await vi.waitFor(() => expect(finished).toBe(true));
  });

  it("starts work accepted by an in-flight request before graceful shutdown drains", async () => {
    const supervisor = new ServerOwnedOperationSupervisor();
    const { dependencies, handlers } = commandDependencies(supervisor);
    const acceptanceStarted = deferred<void>();
    const releaseAcceptance = deferred<void>();
    const workStarted = deferred<void>();
    const releaseWork = deferred<void>();
    handlers.submitAnswer.mockImplementation(async (input) => {
      acceptanceStarted.resolve();
      await releaseAcceptance.promise;
      const acceptedOperation = operation(input, "submit_answer", {
        status: "processing",
        result: null,
        completedAt: null,
        leaseAcquiredAt: now,
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        leaseOwner: "worker-1",
      });
      return {
        operation: acceptedOperation,
        work: {
          operationId: acceptedOperation.id,
          async start() {
            workStarted.resolve();
            await releaseWork.promise;
            return {
              ...acceptedOperation,
              status: "succeeded",
              completedAt: now,
            };
          },
        },
      };
    });
    const instance = await createApp(dependencies);
    instance.addHook("onClose", async () => supervisor.shutdown());
    const address = await instance.listen({ host: "127.0.0.1", port: 0 });
    const request = fetch(`${address}/api/v1/interviews/interview-1/answers`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "in-flight-shutdown-key",
      },
      body: JSON.stringify({ expectedVersion: 3, text: "回答" }),
    });
    await acceptanceStarted.promise;

    const close = instance.close();
    releaseAcceptance.resolve();
    const response = await request;
    expect(response.status).toBe(202);
    await workStarted.promise;
    expect(await Promise.race([close.then(() => "closed"), Promise.resolve("draining")])).toBe(
      "draining",
    );

    releaseWork.resolve();
    await close;
    expect(supervisor.activeOperationCount).toBe(0);
  });

  it("returns canonical report Operation results and stable retryable failures", async () => {
    const { dependencies, handlers } = commandDependencies();
    handlers.continueInterview
      .mockImplementationOnce(async (input) =>
        operation(input, "generate_report", {
          result: { reportId: "report-final" },
        }),
      )
      .mockImplementationOnce(async (input) =>
        operation(input, "generate_report", {
          status: "failed",
          retryable: true,
          result: null,
          error: {
            code: "model_failure",
            message: "provider internals",
            retryable: true,
          },
        }),
      );
    const instance = await createApp(dependencies);

    const succeeded = await instance.inject({
      method: "POST",
      url: "/api/v1/interviews/interview-1/continue",
      headers: { "idempotency-key": "report-success-key" },
      payload: { expectedVersion: 3 },
    });
    expect(succeeded.statusCode).toBe(200);
    expect(succeeded.json()).toMatchObject({
      operationId: "server-operation-1",
      status: "succeeded",
      result: { reportId: "report-final" },
    });

    const failed = await instance.inject({
      method: "POST",
      url: "/api/v1/interviews/interview-1/continue",
      headers: { "idempotency-key": "report-failure-key" },
      payload: { expectedVersion: 3 },
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({
      error: {
        code: "operation_failure",
        operationId: "server-operation-2",
        failure: {
          code: "model_failure",
          message: "Model processing failed.",
          retryable: true,
        },
      },
    });
  });

  it("maps model failures, command rejection, and version conflicts without leaking details", async () => {
    const { dependencies, handlers } = commandDependencies();
    const instance = await createApp(dependencies);
    handlers.submitAnswer
      .mockImplementationOnce(async (input) =>
        operation(input, "submit_answer", {
          status: "failed",
          retryable: true,
          result: null,
          error: {
            code: "model_failure",
            message: "provider token=secret",
            retryable: true,
          },
        }),
      )
      .mockImplementationOnce(async (input) =>
        operation(input, "submit_answer", {
          status: "failed",
          result: null,
          error: {
            code: "operation_failed",
            message: "secret domain reason",
            retryable: false,
            classification: "command_rejected",
          },
        }),
      )
      .mockImplementationOnce(async (input) =>
        operation(input, "submit_answer", {
          status: "failed",
          result: null,
          error: {
            code: "operation_failed",
            message: "expected 2, actual 3",
            retryable: false,
          },
        }),
      );

    const modelFailure = await instance.inject({
      method: "POST",
      url: "/api/v1/interviews/interview-1/answers",
      headers: { "idempotency-key": "model-failure-key" },
      payload: { expectedVersion: 2, text: "回答" },
    });
    expect(modelFailure.statusCode).toBe(503);
    expect(modelFailure.json()).toEqual({
      error: {
        code: "operation_failure",
        operationId: "server-operation-1",
        failure: {
          code: "model_failure",
          message: "Model processing failed.",
          retryable: true,
        },
      },
    });

    const rejection = await instance.inject({
      method: "POST",
      url: "/api/v1/interviews/interview-1/answers",
      headers: { "idempotency-key": "rejection-key" },
      payload: { expectedVersion: 2, text: "回答" },
    });
    expect(rejection.statusCode).toBe(409);
    expect(rejection.json()).toEqual({
      error: {
        code: "command_rejected",
        message: "The interview does not accept this command in its current state.",
      },
    });

    const conflict = await instance.inject({
      method: "POST",
      url: "/api/v1/interviews/interview-1/answers",
      headers: { "idempotency-key": "version-key" },
      payload: { expectedVersion: 2, text: "回答" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: {
        code: "version_conflict",
        message: "Interview state changed; reload the canonical state and retry.",
        interviewId: "interview-1",
        currentVersion: 3,
        currentState: {
          status: "active",
          phase: "awaiting_response",
        },
      },
    });
    expect(modelFailure.body + rejection.body + conflict.body).not.toContain("secret");
  });

  it("maps repository save races to the current canonical version and state", async () => {
    const { dependencies, handlers } = commandDependencies();
    handlers.continueInterview.mockRejectedValueOnce(
      new RepositoryVersionConflictError("interview-1", 2, 3),
    );
    const instance = await createApp(dependencies);

    const response = await instance.inject({
      method: "POST",
      url: "/api/v1/interviews/interview-1/continue",
      headers: { "idempotency-key": "save-race-key" },
      payload: { expectedVersion: 2 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: "version_conflict",
        message: "Interview state changed; reload the canonical state and retry.",
        interviewId: "interview-1",
        currentVersion: 3,
        currentState: {
          status: "active",
          phase: "awaiting_response",
        },
      },
    });
  });

  it.each([
    {
      error: new RepositoryIdempotencyConflictError("interview-command", "secret-key"),
      status: 409,
      code: "command_rejected",
    },
    {
      error: new ActiveInterviewExistsError(parseInterviewId("secret-active-interview")),
      status: 409,
      code: "command_rejected",
    },
    {
      error: new RepositoryOperationRetryConflictError("secret-operation"),
      status: 409,
      code: "command_rejected",
    },
    {
      error: new RepositoryInterviewUnavailableError("interview-1", "abandoned", 4),
      status: 409,
      code: "command_rejected",
    },
    {
      error: new RepositoryInterviewExpiredError(
        "interview-1",
        3,
        4,
        new Date("2026-08-12T02:00:00.000Z"),
      ),
      status: 409,
      code: "command_rejected",
    },
    {
      error: new RepositoryInterviewUnavailableError("interview-1", "deleting", 4),
      status: 404,
      code: "not_found",
    },
    {
      error: new RepositoryNotFoundError("Operation", "secret-operation"),
      status: 404,
      code: "not_found",
      resource: "operation",
    },
  ])("maps repository command failures to stable envelopes: $code", async (testCase) => {
    const { dependencies, handlers } = commandDependencies();
    handlers.retry.mockRejectedValueOnce(testCase.error);
    const instance = await createApp(dependencies);

    const response = await instance.inject({
      method: "POST",
      url: "/api/v1/interviews/interview-1/retry",
      headers: { "idempotency-key": "repository-error-key" },
      payload: { expectedVersion: 3, operationId: "failed-operation" },
    });

    expect(response.statusCode).toBe(testCase.status);
    expect(response.json()).toMatchObject({
      error: {
        code: testCase.code,
        ...("resource" in testCase ? { resource: testCase.resource } : {}),
      },
    });
    expect(response.body).not.toContain("secret");
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
