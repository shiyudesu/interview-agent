import { parseAccountId, parseInterviewId, parseOperationId } from "@interview-agent/domain";
import type { BetterAuthOptions } from "better-auth";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerApplication } from "../src/app.js";
import type { AuthenticatedRequestContext, Authentication } from "../src/auth.js";
import type { InterviewCommandRouteDependencies } from "../src/command-routes.js";
import { DeletionOrchestrationService } from "../src/deletion.js";
import {
  OperationEventBroker,
  type OperationEventRouteDependencies,
} from "../src/operation-events.js";
import type { CanonicalReadRouteDependencies } from "../src/read-routes.js";
import { API_BODY_LIMITS, API_RATE_LIMITS } from "../src/security.js";
import { createServer } from "../src/server.js";

const apps: ReturnType<typeof createServer>[] = [];
const config = {
  environment: "test",
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
  const instance = createServer({ logger: false });
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
    starter: { start: () => undefined },
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

function operationEvents(): OperationEventRouteDependencies {
  return {
    broker: new OperationEventBroker(),
    access: {
      findAccessible: async () => null,
    },
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((instance) => instance.close()));
});

describe("registerApplication", () => {
  it.each(["test", "development"] as const)(
    "serves generated OpenAPI documentation without authentication in %s",
    async (environment) => {
      const getSession = vi.fn(async () => ({ context: null, headers: new Headers() }));
      const instance = app();
      await registerApplication(instance, {
        authentication: authentication({ getSession }),
        config: { ...config, environment },
        deletion: deletion(),
        interviewCommands: interviewCommands(),
        canonicalReads: canonicalReads(),
        operationEvents: operationEvents(),
      });

      const jsonResponse = await instance.inject({
        method: "GET",
        url: "/documentation/json",
      });
      const uiResponse = await instance.inject({
        method: "GET",
        url: "/documentation/",
      });
      const document = jsonResponse.json();

      expect(jsonResponse.statusCode).toBe(200);
      expect(uiResponse.statusCode).toBe(200);
      expect(getSession).not.toHaveBeenCalled();
      expect(instance.hasDecorator("swagger")).toBe(true);
      expect(instance.hasDecorator("swaggerCSP")).toBe(true);
      expect(document.openapi).toBe("3.1.0");
      expect(document.paths["/api/auth/*"]).toBeUndefined();
      expect(document.components.securitySchemes.betterAuthSession).toMatchObject({
        type: "apiKey",
        in: "cookie",
        name: "better-auth.session_token",
      });
      expect(document.security).toEqual([{ betterAuthSession: [] }]);

      const createInterview = document.paths["/api/v1/interviews"].post;
      const createInterviewBody =
        createInterview.requestBody.content["application/json"].schema.properties;
      expect(createInterview.summary).toBe("Create an interview");
      expect(createInterviewBody).toEqual(
        expect.objectContaining({
          expectedVersion: expect.any(Object),
          questionCount: expect.any(Object),
        }),
      );
      expect(
        createInterview.parameters.some(
          (parameter: { in: string; name: string }) =>
            parameter.in === "header" && parameter.name.toLowerCase() === "idempotency-key",
        ),
      ).toBe(true);
      expect(Object.keys(createInterview.responses)).toEqual(
        expect.arrayContaining([
          "200",
          "202",
          "400",
          "401",
          "403",
          "404",
          "409",
          "413",
          "429",
          "500",
          "503",
        ]),
      );
      expect(
        createInterview.responses["202"].content["application/json"].schema.anyOf,
      ).toBeDefined();
      expect(JSON.stringify(createInterview.responses["200"])).toContain('"succeeded"');
      expect(JSON.stringify(createInterview.responses["200"])).not.toContain('"pending"');
      expect(JSON.stringify(createInterview.responses["202"])).toContain('"pending"');
      expect(JSON.stringify(createInterview.responses["202"])).toContain('"processing"');
      expect(JSON.stringify(createInterview.responses["202"])).not.toContain('"succeeded"');
      expect(JSON.stringify(createInterview.responses["400"])).toContain('"validation_error"');
      expect(JSON.stringify(createInterview.responses["400"])).not.toContain('"internal_error"');
      expect(JSON.stringify(createInterview.responses["401"])).toContain('"unauthorized"');
      expect(JSON.stringify(createInterview.responses["403"])).toContain('"cross_origin_request"');
      expect(JSON.stringify(createInterview.responses["404"])).toContain('"not_found"');
      expect(JSON.stringify(createInterview.responses["409"])).toContain('"version_conflict"');
      expect(JSON.stringify(createInterview.responses["409"])).toContain('"command_rejected"');
      expect(JSON.stringify(createInterview.responses["413"])).toContain('"payload_too_large"');
      expect(JSON.stringify(createInterview.responses["429"])).toContain('"rate_limit_exceeded"');
      expect(JSON.stringify(createInterview.responses["500"])).toContain('"internal_error"');
      expect(JSON.stringify(createInterview.responses["503"])).toContain('"operation_failure"');

      const history = document.paths["/api/v1/interviews"].get;
      expect(
        history.parameters.map((parameter: { in: string; name: string }) => [
          parameter.in,
          parameter.name,
        ]),
      ).toEqual(
        expect.arrayContaining([
          ["query", "cursor"],
          ["query", "limit"],
        ]),
      );
      expect(
        document.paths["/api/v1/interviews/active"].get.responses["200"].content["application/json"]
          .schema.anyOf,
      ).toBeDefined();
      expect(Object.keys(document.paths["/api/v1/account"].get.responses)).toEqual([
        "200",
        "401",
        "404",
        "429",
        "500",
      ]);
      expect(Object.keys(document.paths["/api/v1/interviews/active"].get.responses)).toEqual([
        "200",
        "401",
        "404",
        "429",
        "500",
      ]);
      expect(Object.keys(history.responses)).toEqual(["200", "400", "401", "429", "500"]);
      expect(
        JSON.stringify(document.paths["/api/v1/operations/{operationId}"].get.responses["404"]),
      ).toContain('"operation"');
      expect(
        JSON.stringify(
          document.paths["/api/v1/interviews/{interviewId}/report"].get.responses["404"],
        ),
      ).toContain('"report"');

      const answer = document.paths["/api/v1/interviews/{interviewId}/answers"].post;
      expect(
        answer.parameters.map((parameter: { in: string; name: string }) => [
          parameter.in,
          parameter.name.toLowerCase(),
        ]),
      ).toEqual(
        expect.arrayContaining([
          ["path", "interviewid"],
          ["header", "idempotency-key"],
        ]),
      );
      expect(answer.requestBody.content["application/json"].schema.properties).toEqual(
        expect.objectContaining({
          expectedVersion: expect.any(Object),
          text: expect.any(Object),
        }),
      );

      const events = document.paths["/api/v1/operations/{operationId}/events"].get;
      expect(events.responses["200"].content).toEqual({
        "text/event-stream": {
          schema: expect.objectContaining({ type: "string" }),
        },
      });
      expect(events.responses["204"].content).toBeUndefined();
      expect(events.responses["204"].description).toContain("terminal");
      expect(events.responses["400"].content["application/json"]).toBeDefined();
      expect(JSON.stringify(events.responses["400"])).toContain('"validation_error"');
      expect(JSON.stringify(events.responses["401"])).toContain('"unauthorized"');
      expect(JSON.stringify(events.responses["404"])).toContain('"operation"');
      expect(JSON.stringify(events.responses["409"])).toContain(
        '"operation_event_replay_unavailable"',
      );
      expect(JSON.stringify(events.responses["500"])).toContain('"internal_error"');
      expect(
        events.parameters.some(
          (parameter: { in: string; name: string }) =>
            parameter.in === "header" && parameter.name.toLowerCase() === "last-event-id",
        ),
      ).toBe(true);

      const commandOperations = [
        document.paths["/api/v1/interviews"].post,
        document.paths["/api/v1/interviews/{interviewId}/answers"].post,
        document.paths["/api/v1/interviews/{interviewId}/supplements"].post,
        document.paths["/api/v1/interviews/{interviewId}/clarifications"].post,
        document.paths["/api/v1/interviews/{interviewId}/unknown"].post,
        document.paths["/api/v1/interviews/{interviewId}/skip"].post,
        document.paths["/api/v1/interviews/{interviewId}/continue"].post,
        document.paths["/api/v1/interviews/{interviewId}/end-early"].post,
        document.paths["/api/v1/interviews/{interviewId}/abandon"].post,
        document.paths["/api/v1/interviews/{interviewId}/retry"].post,
      ];
      for (const operation of commandOperations) {
        expect(Object.keys(operation.responses)).toEqual(
          expect.arrayContaining([
            "200",
            "202",
            "400",
            "401",
            "403",
            "404",
            "409",
            "413",
            "429",
            "500",
            "503",
          ]),
        );
      }

      const deletionOperations = [
        document.paths["/api/v1/interviews/{interviewId}"].delete,
        document.paths["/api/v1/account"].delete,
      ];
      for (const operation of deletionOperations) {
        expect(Object.keys(operation.responses)).toEqual(
          expect.arrayContaining(["202", "400", "401", "403", "404", "413", "429", "500"]),
        );
      }

      expect(Object.keys(events.responses)).toEqual(
        expect.arrayContaining(["200", "204", "400", "401", "404", "409", "429", "500"]),
      );
    },
  );

  it("does not register documentation routes or decorators in production", async () => {
    const getSession = vi.fn(async () => ({ context: null, headers: new Headers() }));
    const instance = app();
    await registerApplication(instance, {
      authentication: authentication({ getSession }),
      config: { ...config, environment: "production" },
      deletion: deletion(),
      interviewCommands: interviewCommands(),
      canonicalReads: canonicalReads(),
      operationEvents: operationEvents(),
    });

    const [jsonResponse, yamlResponse, uiResponse] = await Promise.all([
      instance.inject({ method: "GET", url: "/documentation/json" }),
      instance.inject({ method: "GET", url: "/documentation/yaml" }),
      instance.inject({ method: "GET", url: "/documentation/" }),
    ]);

    expect(jsonResponse.statusCode).toBe(404);
    expect(yamlResponse.statusCode).toBe(404);
    expect(uiResponse.statusCode).toBe(404);
    expect(getSession).not.toHaveBeenCalled();
    expect(instance.hasDecorator("swagger")).toBe(false);
    expect(instance.hasDecorator("swaggerCSP")).toBe(false);
    expect(instance.printPlugins()).not.toContain("@fastify/swagger");
  });

  it("wires endpoint-specific limits and rejects cross-origin API mutations", async () => {
    const routes: {
      readonly method: string | readonly string[];
      readonly url: string;
      readonly bodyLimit?: number;
      readonly config?: { readonly rateLimit?: unknown };
    }[] = [];
    const getSession = vi.fn(async () => ({ context: null, headers: new Headers() }));
    const instance = app();
    instance.addHook("onRoute", (route) => {
      routes.push(route);
    });
    await registerApplication(instance, {
      authentication: authentication({ getSession }),
      config,
      deletion: deletion(),
      interviewCommands: interviewCommands(),
      canonicalReads: canonicalReads(),
      operationEvents: operationEvents(),
    });

    const route = (method: string, url: string) => {
      const found = routes.find(
        (candidate) =>
          candidate.url === url &&
          (Array.isArray(candidate.method)
            ? candidate.method.includes(method)
            : candidate.method === method),
      );
      if (found === undefined) {
        throw new Error(`Route ${method} ${url} was not registered`);
      }
      return found;
    };

    expect(route("POST", "/api/auth/*").bodyLimit).toBe(API_BODY_LIMITS.authentication);
    expect(route("POST", "/api/v1/interviews").bodyLimit).toBe(API_BODY_LIMITS.controlCommand);
    expect(route("POST", "/api/v1/interviews/:interviewId/answers").bodyLimit).toBe(
      API_BODY_LIMITS.textCommand,
    );
    expect(route("DELETE", "/api/v1/account").bodyLimit).toBe(API_BODY_LIMITS.deletion);
    expect(route("GET", "/api/v1/account").config?.rateLimit).toEqual(API_RATE_LIMITS.read);
    expect(route("POST", "/api/v1/interviews").config?.rateLimit).toEqual(API_RATE_LIMITS.command);
    expect(route("GET", "/api/v1/operations/:operationId/events").config?.rateLimit).toEqual(
      API_RATE_LIMITS.stream,
    );
    expect(route("DELETE", "/api/v1/account").config?.rateLimit).toEqual(API_RATE_LIMITS.deletion);

    const response = await instance.inject({
      method: "POST",
      url: "/api/v1/interviews",
      headers: {
        origin: "https://attacker.example.test",
        "idempotency-key": "cross-origin-command",
      },
      payload: {
        questionCount: 5,
        expectedVersion: 0,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: "cross_origin_request" },
    });
    expect(getSession).not.toHaveBeenCalled();
  });

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
      operationEvents: operationEvents(),
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
      operationEvents: operationEvents(),
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
      operationEvents: operationEvents(),
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
      operationEvents: operationEvents(),
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
      operationEvents: operationEvents(),
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
    const events = operationEvents();
    const eraseInterview = vi.spyOn(events.broker, "eraseInterview");
    const eraseAccount = vi.spyOn(events.broker, "eraseAccount");
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
      operationEvents: events,
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
    expect(eraseInterview).toHaveBeenCalledWith(context.accountId, parseInterviewId("interview-1"));
    expect(eraseAccount).toHaveBeenCalledWith(context.accountId);
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
      operationEvents: operationEvents(),
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
