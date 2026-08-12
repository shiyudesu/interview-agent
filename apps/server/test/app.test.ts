import { parseAccountId, parseInterviewId, parseOperationId } from "@interview-agent/domain";
import type { BetterAuthOptions } from "better-auth";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerApplication } from "../src/app.js";
import type { AuthenticatedRequestContext, Authentication } from "../src/auth.js";
import type { InterviewCommandRouteDependencies } from "../src/command-routes.js";
import { DeletionOrchestrationService } from "../src/deletion.js";
import type { CanonicalReadRouteDependencies } from "../src/read-routes.js";

const apps: ReturnType<typeof Fastify>[] = [];
const config = {
  auth: {
    secret: "0123456789abcdef0123456789abcdef",
    baseUrl: "http://localhost:3000",
  },
} as const;

function authentication(changes: Partial<Authentication> = {}): Authentication {
  const options: BetterAuthOptions = {};
  return {
    handler: async () => new Response(null, { status: 404 }),
    options,
    getSession: async () => ({ context: null, headers: new Headers() }),
    ...changes,
  };
}

function app() {
  const instance = Fastify({ logger: false });
  apps.push(instance);
  return instance;
}

function deletion() {
  return new DeletionOrchestrationService({
    markInterviewDeleting: async () => null,
    markAccountDeleting: async () => null,
  });
}

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
    states: {
      findById: async () => null,
    },
    now: () => new Date("2026-08-12T00:00:00.000Z"),
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

afterEach(async () => {
  await Promise.all(apps.splice(0).map((instance) => instance.close()));
});

describe("registerApplication", () => {
  it("mounts Better Auth and preserves request, response, and Set-Cookie headers", async () => {
    let receivedRequest: Request | undefined;
    const handler = vi.fn(async (request: Request) => {
      receivedRequest = request;
      const headers = new Headers({ "content-type": "application/json" });
      headers.append("set-cookie", "session=one; HttpOnly; SameSite=Lax");
      headers.append("set-cookie", "state=two; HttpOnly; SameSite=Lax");
      return new Response(JSON.stringify({ ok: true }), { status: 201, headers });
    });
    const instance = app();
    await registerApplication(instance, {
      authentication: authentication({ handler }),
      config,
      deletion: deletion(),
      interviewCommands: interviewCommands(),
      canonicalReads: canonicalReads(),
    });

    const response = await instance.inject({
      method: "POST",
      url: "/api/auth/email-otp/send-verification-otp",
      headers: {
        cookie: "existing=value",
        origin: "http://localhost:3000",
        "x-interview-client-ip": "spoofed-client",
      },
      payload: {
        email: "candidate@example.test",
        type: "sign-in",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ ok: true });
    expect(response.headers["set-cookie"]).toEqual([
      "session=one; HttpOnly; SameSite=Lax",
      "state=two; HttpOnly; SameSite=Lax",
    ]);
    expect(receivedRequest?.url).toBe(
      "http://localhost:3000/api/auth/email-otp/send-verification-otp",
    );
    expect(receivedRequest?.headers.get("x-interview-client-ip")).toBe("127.0.0.1");
    await expect(receivedRequest?.json()).resolves.toEqual({
      email: "candidate@example.test",
      type: "sign-in",
    });
  });

  it("forwards URL-encoded authentication bodies without JSON conversion", async () => {
    let receivedBody = "";
    const instance = app();
    await registerApplication(instance, {
      authentication: authentication({
        handler: async (request) => {
          receivedBody = await request.text();
          return Response.json({ ok: true });
        },
      }),
      config,
      deletion: deletion(),
      interviewCommands: interviewCommands(),
      canonicalReads: canonicalReads(),
    });

    const response = await instance.inject({
      method: "POST",
      url: "/api/auth/sign-in/social",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "provider=github&callbackURL=%2F",
    });

    expect(response.statusCode).toBe(200);
    expect(receivedBody).toBe("provider=github&callbackURL=%2F");
  });

  it("loads a normalized authentication context for API v1 requests only", async () => {
    const context: AuthenticatedRequestContext = {
      accountId: parseAccountId("account-1"),
      sessionId: "session-1",
      email: "candidate@example.test",
      name: "Candidate",
    };
    const sessionHeaders = new Headers();
    sessionHeaders.append("set-cookie", "session=refreshed; HttpOnly; SameSite=Lax");
    const getSession = vi.fn(async () => ({
      context,
      headers: sessionHeaders,
    }));
    const instance = app();
    await registerApplication(instance, {
      authentication: authentication({ getSession }),
      config,
      deletion: deletion(),
      interviewCommands: interviewCommands(),
      canonicalReads: canonicalReads(),
    });
    instance.get("/api/v1/context", async (request) => request.authContext);
    instance.get("/health", async (request) => request.authContext);

    const protectedResponse = await instance.inject({
      method: "GET",
      url: "/api/v1/context",
      headers: { cookie: "better-auth.session_token=test" },
    });
    const encodedResponse = await instance.inject({
      method: "GET",
      url: "/api/%76%31/context",
      headers: { cookie: "better-auth.session_token=test" },
    });
    const healthResponse = await instance.inject({ method: "GET", url: "/health" });

    expect(protectedResponse.json()).toEqual(context);
    expect(encodedResponse.json()).toEqual(context);
    expect(protectedResponse.headers["set-cookie"]).toEqual([
      "session=refreshed; HttpOnly; SameSite=Lax",
    ]);
    expect(healthResponse.json()).toBeNull();
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it("returns a sanitized failure when the authentication handler throws", async () => {
    const instance = app();
    await registerApplication(instance, {
      authentication: authentication({
        handler: async () => {
          throw new Error("SMTP rejected candidate@example.test with OTP 123456");
        },
      }),
      config,
      deletion: deletion(),
      interviewCommands: interviewCommands(),
      canonicalReads: canonicalReads(),
    });

    const response = await instance.inject({
      method: "POST",
      url: "/api/auth/email-otp/send-verification-otp",
      payload: { email: "candidate@example.test", type: "sign-in" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: "authentication_failure",
        message: "Authentication request failed",
      },
    });
    expect(response.body).not.toContain("candidate@example.test");
    expect(response.body).not.toContain("123456");
  });

  it("returns a stable internal envelope when protected-session loading fails", async () => {
    const instance = app();
    await registerApplication(instance, {
      authentication: authentication({
        getSession: async () => {
          throw new Error("database password=secret");
        },
      }),
      config,
      deletion: deletion(),
      interviewCommands: interviewCommands(),
      canonicalReads: canonicalReads(),
    });

    const response = await instance.inject({
      method: "GET",
      url: "/api/v1/account",
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

  it("requires confirmation and owner context for deletion routes", async () => {
    const context: AuthenticatedRequestContext = {
      accountId: parseAccountId("account-1"),
      sessionId: "session-1",
      email: "candidate@example.test",
      name: "Candidate",
    };
    const requestedAt = new Date("2026-08-11T00:00:00.000Z");
    const purgeDeadlineAt = new Date("2026-08-18T00:00:00.000Z");
    const markInterviewDeleting = vi.fn(async (interviewId, accountId) => ({
      requestId: "request-1",
      scope: "interview" as const,
      ownerUserId: accountId,
      interviewId,
      requestedAt,
      purgeDueAt: new Date("2026-08-17T00:00:00.000Z"),
      purgeDeadlineAt,
      created: true,
      affectedInterviewCount: 1,
      cancelledOperationCount: 0,
    }));
    const markAccountDeleting = vi.fn(async (accountId) => ({
      requestId: "request-2",
      scope: "account" as const,
      ownerUserId: accountId,
      interviewId: null,
      requestedAt,
      purgeDueAt: new Date("2026-08-17T00:00:00.000Z"),
      purgeDeadlineAt,
      created: true,
      affectedInterviewCount: 1,
      cancelledOperationCount: 0,
    }));
    const instance = app();
    await registerApplication(instance, {
      authentication: authentication({
        getSession: async () => ({ context, headers: new Headers() }),
      }),
      config,
      deletion: new DeletionOrchestrationService({
        markInterviewDeleting,
        markAccountDeleting,
      }),
      interviewCommands: interviewCommands(),
      canonicalReads: canonicalReads(),
    });

    const missingConfirmation = await instance.inject({
      method: "DELETE",
      url: "/api/v1/interviews/interview-1",
      payload: {},
    });
    const interviewResponse = await instance.inject({
      method: "DELETE",
      url: "/api/v1/interviews/interview-1",
      payload: { confirmed: true },
    });
    const accountResponse = await instance.inject({
      method: "DELETE",
      url: "/api/v1/account",
      payload: { confirmed: true },
    });

    expect(missingConfirmation.statusCode).toBe(400);
    expect(interviewResponse.statusCode).toBe(202);
    expect(interviewResponse.json()).toEqual({
      status: "deleting",
      requestedAt: requestedAt.toISOString(),
      purgeDeadlineAt: purgeDeadlineAt.toISOString(),
    });
    expect(accountResponse.statusCode).toBe(202);
    expect(markInterviewDeleting).toHaveBeenCalledWith(
      parseInterviewId("interview-1"),
      context.accountId,
    );
    expect(markAccountDeleting).toHaveBeenCalledWith(context.accountId);
  });

  it("sanitizes unexpected deletion failures", async () => {
    const context: AuthenticatedRequestContext = {
      accountId: parseAccountId("account-1"),
      sessionId: "session-1",
      email: "candidate@example.test",
      name: "Candidate",
    };
    const instance = app();
    await registerApplication(instance, {
      authentication: authentication({
        getSession: async () => ({ context, headers: new Headers() }),
      }),
      config,
      deletion: new DeletionOrchestrationService({
        markInterviewDeleting: async () => {
          throw new Error("sensitive database detail");
        },
        markAccountDeleting: async () => {
          throw new Error("sensitive database detail");
        },
      }),
      interviewCommands: interviewCommands(),
      canonicalReads: canonicalReads(),
    });

    const response = await instance.inject({
      method: "DELETE",
      url: "/api/v1/account",
      payload: { confirmed: true },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: "deletion_failure",
        message: "Deletion request failed",
      },
    });
    expect(response.body).not.toContain("sensitive database detail");
  });
});
