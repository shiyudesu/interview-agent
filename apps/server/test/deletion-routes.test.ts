import {
  AccountDeletionNotFoundResponseSchema,
  DeletionAcceptedResponseSchema,
  DeletionServerFailureResponseSchema,
  DeletionUnauthorizedResponseSchema,
  DeletionValidationErrorResponseSchema,
  InterviewDeletionNotFoundResponseSchema,
} from "@interview-agent/contracts";
import type { StoredOperation } from "@interview-agent/db";
import { parseAccountId, parseInterviewId, parseOperationId } from "@interview-agent/domain";
import type { BetterAuthOptions } from "better-auth";
import Fastify from "fastify";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerApplication } from "../src/app.js";
import type {
  AuthenticatedRequestContext,
  Authentication,
  AuthenticationSessionResult,
} from "../src/auth.js";
import type { InterviewCommandRouteDependencies } from "../src/command-routes.js";
import { type DeletionLifecycle, DeletionOrchestrationService } from "../src/deletion.js";
import {
  OperationEventBroker,
  type OperationEventRouteDependencies,
} from "../src/operation-events.js";
import type { CanonicalReadRouteDependencies } from "../src/read-routes.js";

const apps: ReturnType<typeof Fastify>[] = [];
const accountId = parseAccountId("deletion-route-owner");
const interviewId = parseInterviewId("deletion-route-interview");
const requestedAt = new Date("2026-08-12T12:00:00.000Z");
const purgeDeadlineAt = new Date("2026-08-19T12:00:00.000Z");
const context: AuthenticatedRequestContext = {
  accountId,
  sessionId: "deletion-route-session",
  email: "candidate@example.test",
  name: "Candidate",
};
const config = {
  auth: {
    secret: "0123456789abcdef0123456789abcdef",
    baseUrl: "http://localhost:3000",
  },
} as const;

function interviewCommands(): InterviewCommandRouteDependencies {
  const unavailable = async () => {
    throw new Error("Command handler was not configured for this test");
  };
  return {
    handlers: {
      createInterview: unavailable,
      submitAnswer: unavailable,
      submitSupplement: unavailable,
      requestQuestionClarification: unavailable,
      markUnknown: unavailable,
      skip: unavailable,
      continueInterview: unavailable,
      endEarly: unavailable,
      abandon: unavailable,
      retry: unavailable,
    },
    starter: { start: () => undefined },
    states: { findById: async () => null },
    now: () => new Date(requestedAt),
    nextInterviewId: () => parseInterviewId("generated-interview"),
    nextOperationId: () => parseOperationId("generated-operation"),
  };
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

function authentication(
  getSession: (headers: Headers) => Promise<AuthenticationSessionResult>,
): Authentication {
  const options: BetterAuthOptions = {};
  return {
    handler: async () => new Response(null, { status: 404 }),
    options,
    getSession,
  };
}

function operationEvents(broker: OperationEventBroker): OperationEventRouteDependencies {
  return {
    broker,
    access: {
      findAccessible: async () => null,
    },
  };
}

async function createApp(
  lifecycle: DeletionLifecycle,
  options: {
    readonly broker?: OperationEventBroker;
    readonly getSession?: (headers: Headers) => Promise<AuthenticationSessionResult>;
  } = {},
) {
  const instance = Fastify({ logger: false });
  apps.push(instance);
  await registerApplication(instance, {
    authentication: authentication(
      options.getSession ??
        (async (headers) => ({
          context: headers.get("authorization") === "Bearer owner" ? context : null,
          headers: new Headers(),
        })),
    ),
    config,
    deletion: new DeletionOrchestrationService(lifecycle),
    interviewCommands: interviewCommands(),
    canonicalReads: canonicalReads(),
    operationEvents: operationEvents(options.broker ?? new OperationEventBroker()),
  });
  return instance;
}

function acceptedResult(scope: "account" | "interview") {
  return {
    requestId: `deletion-${scope}`,
    scope,
    ownerUserId: accountId,
    interviewId: scope === "interview" ? interviewId : null,
    requestedAt,
    purgeDueAt: new Date("2026-08-18T12:00:00.000Z"),
    purgeDeadlineAt,
    created: true,
    affectedInterviewCount: 1,
    cancelledOperationCount: 1,
  } as const;
}

function operation(
  id: string,
  ownerAccountId = accountId,
  targetInterviewId = interviewId,
): StoredOperation {
  return {
    id: parseOperationId(id),
    accountId: ownerAccountId,
    interviewId: targetInterviewId,
    idempotencyScope: "interview-command",
    idempotencyKey: `${id}-idempotency-key`,
    type: "request_question_clarification",
    status: "processing",
    expectedVersion: 1,
    inputHash: "a".repeat(64),
    attemptCount: 1,
    lastAttemptAt: requestedAt,
    leaseAcquiredAt: requestedAt,
    leaseExpiresAt: new Date(requestedAt.getTime() + 60_000),
    leaseOwner: "deletion-route-worker",
    retryable: false,
    input: { questionPosition: 1 },
    result: null,
    error: null,
    createdAt: requestedAt,
    updatedAt: requestedAt,
    completedAt: null,
  };
}

function expectContract(
  response: {
    readonly statusCode: number;
    readonly body: string;
    json(): unknown;
  },
  statusCode: number,
  schema: TSchema,
) {
  expect(response.statusCode).toBe(statusCode);
  expect(Check(schema, response.json())).toBe(true);
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((instance) => instance.close()));
});

describe("deletion route contracts", () => {
  it("returns stable schema-valid validation and unauthorized envelopes for both routes", async () => {
    const instance = await createApp({
      markInterviewDeleting: async () => acceptedResult("interview"),
      markAccountDeleting: async () => acceptedResult("account"),
    });

    const invalidParams = await instance.inject({
      method: "DELETE",
      url: "/api/v1/interviews/invalid%20interview",
      headers: { authorization: "Bearer owner" },
      payload: { confirmed: true },
    });
    const invalidAccountBody = await instance.inject({
      method: "DELETE",
      url: "/api/v1/account",
      headers: { authorization: "Bearer owner" },
      payload: {},
    });
    const malformedAccountBody = await instance.inject({
      method: "DELETE",
      url: "/api/v1/account",
      headers: {
        authorization: "Bearer owner-session",
        "content-type": "application/json",
      },
      payload: '{"confirmed":',
    });
    const unauthorizedInterview = await instance.inject({
      method: "DELETE",
      url: `/api/v1/interviews/${interviewId}`,
      payload: { confirmed: true },
    });
    const unauthorizedAccount = await instance.inject({
      method: "DELETE",
      url: "/api/v1/account",
      payload: { confirmed: true },
    });

    expectContract(invalidParams, 400, DeletionValidationErrorResponseSchema);
    expectContract(invalidAccountBody, 400, DeletionValidationErrorResponseSchema);
    expectContract(malformedAccountBody, 400, DeletionValidationErrorResponseSchema);
    expect(invalidParams.json()).toMatchObject({
      error: {
        code: "validation_error",
        message: "The request is invalid.",
        issues: [expect.objectContaining({ path: "/interviewId" })],
      },
    });
    expect(malformedAccountBody.json()).toEqual({
      error: {
        code: "validation_error",
        message: "The request is invalid.",
        issues: [
          {
            path: "/body",
            code: "FST_ERR_CTP_INVALID_JSON_BODY",
            message: "The request body is invalid.",
          },
        ],
      },
    });
    expectContract(unauthorizedInterview, 401, DeletionUnauthorizedResponseSchema);
    expectContract(unauthorizedAccount, 401, DeletionUnauthorizedResponseSchema);
  });

  it("uses owner-hidden schema-valid not-found envelopes without private disclosure", async () => {
    const markInterviewDeleting = vi.fn(async () => null);
    const instance = await createApp({
      markInterviewDeleting,
      markAccountDeleting: async () => null,
    });

    const interviewResponse = await instance.inject({
      method: "DELETE",
      url: `/api/v1/interviews/${interviewId}`,
      headers: { authorization: "Bearer owner" },
      payload: { confirmed: true },
    });
    const accountResponse = await instance.inject({
      method: "DELETE",
      url: "/api/v1/account",
      headers: { authorization: "Bearer owner" },
      payload: { confirmed: true },
    });

    expectContract(interviewResponse, 404, InterviewDeletionNotFoundResponseSchema);
    expect(interviewResponse.json()).toEqual({
      error: {
        code: "not_found",
        message: "Resource was not found.",
        resource: "interview",
      },
    });
    expectContract(accountResponse, 404, AccountDeletionNotFoundResponseSchema);
    expect(accountResponse.json()).toEqual({
      error: {
        code: "not_found",
        message: "Resource was not found.",
        resource: "account",
      },
    });
    expect(markInterviewDeleting).toHaveBeenCalledWith(interviewId, accountId);
    expect(`${interviewResponse.body}${accountResponse.body}`).not.toContain(
      "other-owner-private-interview",
    );
  });

  it("synchronously erases matching broker history and listeners before accepting deletion", async () => {
    const broker = new OperationEventBroker();
    const interviewOperation = operation("deletion-interview-operation");
    const accountOperation = operation(
      "deletion-account-operation",
      accountId,
      parseInterviewId("deletion-route-other-interview"),
    );
    const unrelatedOperation = operation(
      "deletion-unrelated-operation",
      parseAccountId("deletion-route-other-owner"),
      parseInterviewId("deletion-route-unrelated-interview"),
    );
    const closeInterviewListener = vi.fn();
    const closeAccountListener = vi.fn();
    broker.subscribe(interviewOperation, 0, () => undefined, closeInterviewListener);
    broker.subscribe(accountOperation, 0, () => undefined, closeAccountListener);
    broker.publishTextDelta(interviewOperation, "PRIVATE_INTERVIEW_EVENT_TEXT", requestedAt);
    broker.publishTextDelta(accountOperation, "PRIVATE_ACCOUNT_EVENT_TEXT", requestedAt);
    broker.publishTextDelta(unrelatedOperation, "UNRELATED_EVENT_TEXT", requestedAt);
    const instance = await createApp(
      {
        markInterviewDeleting: async () => acceptedResult("interview"),
        markAccountDeleting: async () => acceptedResult("account"),
      },
      { broker },
    );

    const interviewResponse = await instance.inject({
      method: "DELETE",
      url: `/api/v1/interviews/${interviewId}`,
      headers: { authorization: "Bearer owner" },
      payload: { confirmed: true },
    });

    expectContract(interviewResponse, 202, DeletionAcceptedResponseSchema);
    expect(closeInterviewListener).toHaveBeenCalledTimes(1);
    expect(broker.history(interviewOperation)).toEqual([]);
    expect(closeAccountListener).not.toHaveBeenCalled();
    expect(broker.history(accountOperation)).toHaveLength(1);
    expect(interviewResponse.body).not.toContain("PRIVATE_INTERVIEW_EVENT_TEXT");

    const accountResponse = await instance.inject({
      method: "DELETE",
      url: "/api/v1/account",
      headers: { authorization: "Bearer owner" },
      payload: { confirmed: true },
    });

    expectContract(accountResponse, 202, DeletionAcceptedResponseSchema);
    expect(closeAccountListener).toHaveBeenCalledTimes(1);
    expect(broker.history(accountOperation)).toEqual([]);
    expect(broker.history(unrelatedOperation)).toHaveLength(1);
    expect(accountResponse.body).not.toContain("PRIVATE_ACCOUNT_EVENT_TEXT");
  });

  it("returns sanitized failures and fails closed after post-commit broker erasure errors", async () => {
    const interviewFailure = await createApp({
      markInterviewDeleting: async () => {
        throw new Error("PRIVATE_DATABASE_DELETION_DETAIL");
      },
      markAccountDeleting: async () => acceptedResult("account"),
    });
    const interviewResponse = await interviewFailure.inject({
      method: "DELETE",
      url: `/api/v1/interviews/${interviewId}`,
      headers: { authorization: "Bearer owner" },
      payload: { confirmed: true },
    });

    const broker = new OperationEventBroker();
    const retainedOperation = operation("deletion-broker-failure");
    const closeRetainedListener = vi.fn();
    broker.subscribe(retainedOperation, 0, () => undefined, closeRetainedListener);
    broker.publishTextDelta(retainedOperation, "PRIVATE_BROKER_RETAINED_TEXT", requestedAt);
    vi.spyOn(broker, "eraseAccount").mockImplementation(() => {
      throw new Error("PRIVATE_BROKER_EVENT_TEXT");
    });
    const markAccountDeleting = vi.fn(async () => acceptedResult("account"));
    const brokerFailure = await createApp(
      {
        markInterviewDeleting: async () => acceptedResult("interview"),
        markAccountDeleting,
      },
      { broker },
    );
    const accountResponse = await brokerFailure.inject({
      method: "DELETE",
      url: "/api/v1/account",
      headers: { authorization: "Bearer owner" },
      payload: { confirmed: true },
    });

    expectContract(interviewResponse, 500, DeletionServerFailureResponseSchema);
    expect(interviewResponse.json()).toEqual({
      error: {
        code: "deletion_failure",
        message: "Deletion request failed",
      },
    });
    expect(interviewResponse.body).not.toContain("PRIVATE_DATABASE_DELETION_DETAIL");
    expectContract(accountResponse, 202, DeletionAcceptedResponseSchema);
    expect(accountResponse.body).not.toContain("PRIVATE_BROKER_EVENT_TEXT");
    expect(accountResponse.body).not.toContain("PRIVATE_BROKER_RETAINED_TEXT");
    expect(markAccountDeleting).toHaveBeenCalledWith(accountId);
    expect(closeRetainedListener).toHaveBeenCalledTimes(1);
    expect(broker.history(retainedOperation)).toEqual([]);

    const authenticationFailure = await createApp(
      {
        markInterviewDeleting: async () => acceptedResult("interview"),
        markAccountDeleting: async () => acceptedResult("account"),
      },
      {
        getSession: async () => {
          throw new Error("PRIVATE_AUTHENTICATION_DETAIL");
        },
      },
    );
    const internalInterviewResponse = await authenticationFailure.inject({
      method: "DELETE",
      url: `/api/v1/interviews/${interviewId}`,
      payload: { confirmed: true },
    });
    const internalAccountResponse = await authenticationFailure.inject({
      method: "DELETE",
      url: "/api/v1/account",
      payload: { confirmed: true },
    });

    expectContract(internalInterviewResponse, 500, DeletionServerFailureResponseSchema);
    expectContract(internalAccountResponse, 500, DeletionServerFailureResponseSchema);
    expect(internalInterviewResponse.json()).toEqual({
      error: {
        code: "internal_error",
        message: "An unexpected error occurred.",
      },
    });
    expect(`${internalInterviewResponse.body}${internalAccountResponse.body}`).not.toContain(
      "PRIVATE_AUTHENTICATION_DETAIL",
    );
  });
});
