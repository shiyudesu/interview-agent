import { TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import {
  ActiveInterviewResponseSchema,
  CompleteReportResponseSchema,
  IdempotencyHeadersSchema,
  OperationEventSchema,
} from "@interview-agent/contracts";
import { describe, expect, it } from "vitest";

import { createServer } from "../src/server.js";

describe("Fastify schema compilation", () => {
  it("compiles representative Operation event, complete report, and active interview schemas", async () => {
    const app = createServer();

    app.post(
      "/operation-event",
      {
        schema: {
          body: OperationEventSchema,
          response: { 200: OperationEventSchema },
        },
      },
      async () => undefined,
    );
    app.post(
      "/complete-report",
      {
        schema: {
          body: CompleteReportResponseSchema,
          response: { 200: CompleteReportResponseSchema },
        },
      },
      async () => undefined,
    );
    app.post(
      "/active-interview",
      {
        schema: {
          body: ActiveInterviewResponseSchema,
          response: { 200: ActiveInterviewResponseSchema },
        },
      },
      async () => undefined,
    );

    await app.ready();
    expect(app.validatorCompiler).toBe(TypeBoxValidatorCompiler);
    expect(app.serializerCompiler).toEqual(expect.any(Function));
    expect(app.hasRoute({ method: "POST", url: "/active-interview" })).toBe(true);
    await app.close();
  });

  it("requires a valid idempotency key without stripping standard Fastify headers", async () => {
    const app = createServer();

    app.post(
      "/mutating-command",
      {
        schema: {
          headers: IdempotencyHeadersSchema,
        },
      },
      async (request) => ({
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
        idempotencyKey: request.headers["idempotency-key"],
        origin: request.headers.origin,
        userAgent: request.headers["user-agent"],
      }),
    );

    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/mutating-command",
      headers: {
        authorization: "Bearer test-token",
        cookie: "session=test-session",
        "idempotency-key": "valid-key-123",
        origin: "https://example.test",
        "user-agent": "contract-test-agent",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      authorization: "Bearer test-token",
      cookie: "session=test-session",
      idempotencyKey: "valid-key-123",
      origin: "https://example.test",
      userAgent: "contract-test-agent",
    });

    for (const headers of [{}, { "idempotency-key": "short" }]) {
      const invalidResponse = await app.inject({
        method: "POST",
        url: "/mutating-command",
        headers,
      });
      expect(invalidResponse.statusCode).toBe(400);
    }

    await app.close();
  });
});
