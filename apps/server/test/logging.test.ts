import { Writable } from "node:stream";

import pino, { type Logger } from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { createLoggerOptions, createServer, LOG_REDACTION_PATHS } from "../src/server.js";

const apps: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("structured logging", () => {
  it("adds request, trace, interview, and Operation correlation fields", async () => {
    const app = createServer({ logger: { level: "silent" } });
    apps.push(app);
    app.get("/interviews/:interviewId/operations/:operationId", async (request) =>
      (request.log as Logger).bindings(),
    );

    const response = await app.inject({
      method: "GET",
      url: "/interviews/interview-log/operations/operation-log",
      headers: {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
    });

    expect(response.json()).toMatchObject({
      requestId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      interviewId: "interview-log",
      operationId: "operation-log",
    });
  });

  it("redacts credentials, OTPs, tokens, and complete answer fields", () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    });
    const logger = pino(createLoggerOptions("info"), destination);

    logger.info({
      req: {
        headers: {
          authorization: "Bearer secret",
          cookie: "better-auth.session_token=secret",
        },
      },
      otp: "123456",
      accessToken: "oauth-token",
      apiKey: "model-key",
      answer: "完整候选人回答",
    });

    const record = JSON.parse(lines.join("")) as Record<string, unknown>;
    expect(record).toMatchObject({
      otp: "[REDACTED]",
      accessToken: "[REDACTED]",
      apiKey: "[REDACTED]",
      answer: "[REDACTED]",
      req: {
        method: "UNKNOWN",
        url: "/",
      },
    });
    expect(lines.join("")).not.toContain("secret");
    expect(lines.join("")).not.toContain("123456");
    expect(LOG_REDACTION_PATHS).toContain("text");
  });

  it("never logs query secrets or raw unhandled error content", async () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    });
    const logger = pino(createLoggerOptions("info"), destination);
    const app = createServer({ loggerInstance: logger });
    apps.push(app);
    app.get("/failure", async () => {
      throw new Error("otp=123456 answer=完整回答 token=secret-token");
    });

    await app.inject({
      method: "GET",
      url: "/failure?token=query-secret",
    });

    const output = lines.join("");
    expect(output).toContain("request_started");
    expect(output).toContain("request_failed");
    expect(output).not.toContain("request_completed");
    expect(
      lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((record) => record["event"] === "request_failed"),
    ).toMatchObject({ statusCode: 500 });
    expect(output).not.toContain("query-secret");
    expect(output).not.toContain("123456");
    expect(output).not.toContain("完整回答");
    expect(output).not.toContain("secret-token");
  });

  it.each([
    "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
  ])("rejects invalid traceparent %s", async (traceparent) => {
    const app = createServer({ logger: { level: "silent" } });
    apps.push(app);
    app.get("/trace", async (request) => (request.log as Logger).bindings());

    const response = await app.inject({
      method: "GET",
      url: "/trace",
      headers: { traceparent },
    });

    expect(response.json()).not.toHaveProperty("traceId");
  });
});
