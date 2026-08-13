import { type OperationEventDto, OperationEventSchema } from "@interview-agent/contracts";
import {
  type PgRepositoryUnitOfWork,
  RepositoryInterviewExpiredError,
  type StoredOperation,
} from "@interview-agent/db";
import { parseAccountId, parseInterviewId, parseOperationId } from "@interview-agent/domain";
import type { BetterAuthOptions } from "better-auth";
import { Check } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerApplication } from "../src/app.js";
import type { AuthenticatedRequestContext, Authentication } from "../src/auth.js";
import type { InterviewCommandRouteDependencies } from "../src/command-routes.js";
import { DeletionOrchestrationService } from "../src/deletion.js";
import {
  createOperationEventRouteDependencies,
  OperationEventBroker,
  OperationEventReplayUnavailableError,
  type OperationEventRouteDependencies,
} from "../src/operation-events.js";
import { ServerOwnedOperationExecution } from "../src/operation-runner.js";
import type { CanonicalReadRouteDependencies } from "../src/read-routes.js";
import { createServer } from "../src/server.js";

const apps: ReturnType<typeof createServer>[] = [];
const ownerId = parseAccountId("operation-event-owner");
const operationId = parseOperationId("operation-event-1");
const occurredAt = new Date("2026-08-12T06:00:00.000Z");
const authContext: AuthenticatedRequestContext = {
  accountId: ownerId,
  sessionId: "operation-event-session",
  email: "candidate@example.test",
  name: "Candidate",
};
const config = {
  environment: "test",
  auth: {
    secret: "0123456789abcdef0123456789abcdef",
    baseUrl: "http://localhost:3000",
  },
} as const;

function authentication(context: AuthenticatedRequestContext | null): Authentication {
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
    now: () => new Date(occurredAt),
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

function operation(
  status: StoredOperation["status"],
  changes: Partial<StoredOperation> = {},
): StoredOperation {
  return {
    id: operationId,
    accountId: ownerId,
    interviewId: parseInterviewId("operation-event-interview"),
    idempotencyScope: "interview-command",
    idempotencyKey: "operation-event-key",
    type: "request_question_clarification",
    status,
    expectedVersion: 1,
    inputHash: "a".repeat(64),
    attemptCount: status === "pending" ? 0 : 1,
    lastAttemptAt: status === "pending" ? null : occurredAt,
    leaseAcquiredAt: status === "processing" ? occurredAt : null,
    leaseExpiresAt: status === "processing" ? new Date(occurredAt.getTime() + 60_000) : null,
    leaseOwner: status === "processing" ? "test-worker" : null,
    retryable: false,
    input: { questionPosition: 1 },
    result:
      status === "succeeded"
        ? {
            interviewId: "operation-event-interview",
            interviewVersion: 2,
            reportId: null,
          }
        : null,
    error:
      status === "failed"
        ? {
            code: "model_failure",
            message: "provider secret",
            retryable: true,
          }
        : null,
    createdAt: occurredAt,
    updatedAt: occurredAt,
    completedAt: status === "succeeded" || status === "failed" ? occurredAt : null,
    ...changes,
  };
}

async function createApp(
  events: OperationEventRouteDependencies,
  context: AuthenticatedRequestContext | null = authContext,
) {
  const instance = createServer({ logger: false });
  apps.push(instance);
  await registerApplication(instance, {
    authentication: authentication(context),
    config,
    deletion: deletion(),
    interviewCommands: interviewCommands(),
    canonicalReads: canonicalReads(),
    operationEvents: {
      terminalPublicationGraceMs: 0,
      ...events,
    },
  });
  return instance;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((instance) => instance.close()));
});

describe("Operation event broker", () => {
  it("does not allocate empty state for unobserved attempts", () => {
    const broker = new OperationEventBroker();
    const target = operation("processing");

    broker.beginAttempt(target);

    expect(broker.hasState(target)).toBe(false);
    expect(broker.history(target)).toEqual([]);
  });

  it("orders validated events, deduplicates terminals, and enforces bounded replay", () => {
    const broker = new OperationEventBroker({ historyLimit: 2 });
    const target = operation("processing");
    const received: OperationEventDto[] = [];
    const subscription = broker.subscribe(
      target,
      0,
      (event) => received.push(event),
      () => {},
    );

    broker.publishTextDelta(target, "完整校验后的澄清文本。", occurredAt);
    const terminal = broker.publishTerminal(operation("succeeded"));
    const duplicateTerminal = broker.publishTerminal(operation("succeeded"));

    expect(received.map((event) => [event.sequence, event.type])).toEqual([
      [1, "text_delta"],
      [2, "succeeded"],
    ]);
    expect(received.every((event) => Check(OperationEventSchema, event))).toBe(true);
    expect(duplicateTerminal).toEqual(terminal);
    expect(broker.history(operation("succeeded"))).toHaveLength(2);
    subscription.unsubscribe();

    const replay = broker.subscribe(
      operation("succeeded"),
      1,
      () => undefined,
      () => {},
    );
    expect(replay.replay.map((event) => event.type)).toEqual(["succeeded"]);
    replay.unsubscribe();

    const truncatedId = parseOperationId("operation-event-truncated");
    const truncated = operation("processing", { id: truncatedId });
    broker.publishTextDelta(truncated, "一", occurredAt);
    broker.publishTextDelta(truncated, "二", occurredAt);
    broker.publishTextDelta(truncated, "三", occurredAt);
    expect(() =>
      broker.subscribe(
        truncated,
        0,
        () => undefined,
        () => {},
      ),
    ).toThrow(OperationEventReplayUnavailableError);

    const bounded = new OperationEventBroker({ historyOperationLimit: 1 });
    const firstId = parseOperationId("operation-event-bounded-first");
    const secondId = parseOperationId("operation-event-bounded-second");
    const first = operation("processing", { id: firstId });
    const second = operation("processing", { id: secondId });
    bounded.publishTextDelta(first, "第一条", occurredAt);
    bounded.publishTextDelta(second, "第二条", occurredAt);
    expect(bounded.history(first)).toEqual([]);
    expect(bounded.history(second)).toHaveLength(1);
  });

  it("publishes validated text and terminal status as one ordered broker batch", () => {
    const broker = new OperationEventBroker();
    const completed = operation("succeeded");

    expect(
      broker.publishTextAndTerminal(completed, "完整校验后的文本。", occurredAt),
    ).toMatchObject([
      { sequence: 1, type: "text_delta" },
      { sequence: 2, type: "succeeded" },
    ]);
    expect(broker.history(completed).map((event) => event.type)).toEqual([
      "text_delta",
      "succeeded",
    ]);
  });

  it("starts retried attempts only after claim publication and keeps sequences monotonic", () => {
    const broker = new OperationEventBroker();
    const firstFailure = operation("failed", {
      error: {
        code: "operation_failed",
        message: "first failure",
        retryable: true,
      },
    });
    broker.publishTerminal(firstFailure);
    expect(broker.history(firstFailure)).toMatchObject([{ sequence: 1, type: "failed" }]);

    const retrying = operation("processing", {
      attemptCount: 2,
      error: null,
      completedAt: null,
    });
    expect(broker.history(retrying)).toHaveLength(1);

    broker.beginAttempt(retrying);
    expect(broker.history(retrying)).toEqual([]);
    broker.publishTextDelta(retrying, "第二次尝试的校验后文本。", occurredAt);
    const secondFailure = operation("failed", {
      attemptCount: 2,
      error: {
        code: "model_failure",
        message: "second failure",
        retryable: true,
      },
    });
    const terminal = broker.publishTerminal(secondFailure);
    expect(broker.publishTerminal(secondFailure)).toEqual(terminal);
    expect(broker.history(secondFailure)).toMatchObject([
      { sequence: 2, type: "text_delta", text: "第二次尝试的校验后文本。" },
      { sequence: 3, type: "failed", failure: { code: "model_failure" } },
    ]);
  });

  it("expires replay promptly and erases owner-scoped state without leakage", async () => {
    const broker = new OperationEventBroker({ replayTtlMs: 5 });
    const secretOwner = parseAccountId("operation-event-secret-owner");
    const secret = operation("processing", { accountId: secretOwner });
    broker.publishTextDelta(secret, "不应长期保留的私有文本。", occurredAt);
    expect(broker.history(operation("processing"))).toEqual([]);

    await waitUntil(() => broker.history(secret).length === 0);
    expect(() =>
      broker.subscribe(
        secret,
        1,
        () => undefined,
        () => {},
      ),
    ).toThrow(OperationEventReplayUnavailableError);

    const close = vi.fn();
    const subscription = broker.subscribe(secret, 0, () => undefined, close);
    broker.publishTextDelta(secret, "删除时必须立即擦除。", occurredAt);
    broker.eraseAccount(secretOwner);
    expect(close).toHaveBeenCalledTimes(1);
    expect(broker.history(secret)).toEqual([]);
    expect(broker.history(operation("processing"))).toEqual([]);
    subscription.unsubscribe();
  });
});

describe("Operation event route", () => {
  it("authenticates, owner-scopes, and safely maps lookup failures", async () => {
    const secretBroker = new OperationEventBroker();
    secretBroker.publishTextDelta(operation("processing"), "另一位用户的私有文本。", occurredAt);
    const missing = vi.fn(async () => null);
    const missingDependencies = {
      broker: secretBroker,
      access: { findAccessible: missing },
    };

    const unauthorizedApp = await createApp(missingDependencies, null);
    const unauthorized = await unauthorizedApp.inject({
      method: "GET",
      url: `/api/v1/operations/${operationId}/events`,
      headers: { accept: "text/event-stream" },
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(missing).not.toHaveBeenCalled();

    const ownerApp = await createApp(missingDependencies);
    const notFound = await ownerApp.inject({
      method: "GET",
      url: `/api/v1/operations/${operationId}/events`,
      headers: { accept: "text/event-stream" },
    });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.body).not.toContain("私有文本");
    expect(missing).toHaveBeenCalledWith(ownerId, authContext.sessionId, operationId);

    const failingApp = await createApp({
      broker: new OperationEventBroker(),
      access: {
        findAccessible: async () => {
          throw new Error("database credentials");
        },
      },
    });
    const failed = await failingApp.inject({
      method: "GET",
      url: `/api/v1/operations/${operationId}/events`,
      headers: { accept: "text/event-stream" },
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({
      error: {
        code: "internal_error",
        message: "An unexpected error occurred.",
      },
    });
    expect(failed.body).not.toContain("credentials");
  });

  it("replays after Last-Event-ID and emits exactly one terminal event", async () => {
    const broker = new OperationEventBroker();
    broker.publishTextDelta(operation("processing"), "完整校验后的澄清文本。", occurredAt);
    broker.publishTerminal(operation("succeeded"));
    const instance = await createApp({
      broker,
      access: { findAccessible: async () => operation("succeeded") },
    });

    const initial = await instance.inject({
      method: "GET",
      url: `/api/v1/operations/${operationId}/events`,
      headers: { accept: "text/event-stream" },
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.headers["content-type"]).toContain("text/event-stream");
    expect(initial.headers["cache-control"]).toBe("no-cache");
    expect(initial.headers.connection).toBe("keep-alive");
    expect(parseSse(initial.body).map((event) => [event.id, event.event])).toEqual([
      ["1", "text_delta"],
      ["2", "succeeded"],
    ]);

    const resumed = await instance.inject({
      method: "GET",
      url: `/api/v1/operations/${operationId}/events`,
      headers: {
        accept: "text/event-stream",
        "last-event-id": "1",
      },
    });
    expect(parseSse(resumed.body).map((event) => [event.id, event.event])).toEqual([
      ["2", "succeeded"],
    ]);

    const afterTerminal = await instance.inject({
      method: "GET",
      url: `/api/v1/operations/${operationId}/events`,
      headers: {
        accept: "text/event-stream",
        "last-event-id": "2",
      },
    });
    expect(afterTerminal.statusCode).toBe(204);
    expect(broker.history(operation("succeeded")).filter(isTerminal)).toHaveLength(1);
    expect(broker.listenerCount(operation("succeeded"))).toBe(0);
  });

  it("uses canonical terminal state after restart and rejects unavailable replay", async () => {
    const terminalApp = await createApp({
      broker: new OperationEventBroker(),
      access: { findAccessible: async () => operation("failed") },
    });
    const unavailableTerminal = await terminalApp.inject({
      method: "GET",
      url: `/api/v1/operations/${operationId}/events`,
      headers: {
        accept: "text/event-stream",
        "last-event-id": "5",
      },
    });
    expect(unavailableTerminal.statusCode).toBe(409);
    expect(unavailableTerminal.json()).toEqual({
      error: {
        code: "operation_event_replay_unavailable",
        message: "Operation event replay is no longer available; reload canonical state.",
        operationId,
      },
    });

    const terminal = await terminalApp.inject({
      method: "GET",
      url: `/api/v1/operations/${operationId}/events`,
      headers: { accept: "text/event-stream" },
    });
    const [event] = parseSse(terminal.body);
    expect(event).toMatchObject({ id: "1", event: "failed" });
    expect(event?.data).toMatchObject({
      operationId,
      sequence: 1,
      type: "failed",
      failure: {
        code: "model_failure",
        message: "Model processing failed.",
        retryable: false,
      },
    });

    const pendingApp = await createApp({
      broker: new OperationEventBroker(),
      access: { findAccessible: async () => operation("processing") },
    });
    const unavailable = await pendingApp.inject({
      method: "GET",
      url: `/api/v1/operations/${operationId}/events`,
      headers: {
        accept: "text/event-stream",
        "last-event-id": "5",
      },
    });
    expect(unavailable.statusCode).toBe(409);
    expect(unavailable.json()).toEqual({
      error: {
        code: "operation_event_replay_unavailable",
        message: "Operation event replay is no longer available; reload canonical state.",
        operationId,
      },
    });

    const invalid = await pendingApp.inject({
      method: "GET",
      url: `/api/v1/operations/${operationId}/events`,
      headers: {
        accept: "text/event-stream",
        "last-event-id": "not-a-sequence",
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      error: { code: "validation_error" },
    });
  });

  it("rejects old event IDs after canonical terminal history is rebuilt", async () => {
    const completed = operation("succeeded");
    const broker = new OperationEventBroker({ replayTtlMs: 5 });
    broker.publishTextAndTerminal(completed, "旧流文本。", occurredAt);
    await waitUntil(() => broker.history(completed).length === 0);
    const instance = await createApp({
      broker,
      access: { findAccessible: async () => completed },
    });

    const rebuilt = await instance.inject({
      method: "GET",
      url: `/api/v1/operations/${operationId}/events`,
      headers: { accept: "text/event-stream" },
    });
    expect(parseSse(rebuilt.body)).toMatchObject([{ id: "1", event: "succeeded" }]);

    const staleReconnect = await instance.inject({
      method: "GET",
      url: `/api/v1/operations/${operationId}/events`,
      headers: {
        accept: "text/event-stream",
        "last-event-id": "1",
      },
    });
    expect(staleReconnect.statusCode).toBe(409);
    expect(staleReconnect.json()).toMatchObject({
      error: { code: "operation_event_replay_unavailable" },
    });
  });

  it("streams live ordering and closes immediately after the terminal event", async () => {
    const broker = new OperationEventBroker();
    const instance = await createApp({
      broker,
      access: { findAccessible: async () => operation("processing") },
      heartbeatIntervalMs: 100,
      statusPollIntervalMs: 100,
    });
    const address = await instance.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/api/v1/operations/${operationId}/events`, {
      headers: { accept: "text/event-stream" },
    });
    expect(response.status).toBe(200);
    expect(broker.listenerCount(operation("processing"))).toBe(1);

    broker.publishTextDelta(operation("processing"), "持久化后的最终澄清文本。", occurredAt);
    broker.publishTerminal(operation("succeeded"));

    const body = await response.text();
    const events = parseSse(body);
    expect(events.map((event) => [event.id, event.event])).toEqual([
      ["1", "text_delta"],
      ["2", "succeeded"],
    ]);
    expect(events.every((event) => Check(OperationEventSchema, event.data))).toBe(true);
    expect(broker.listenerCount(operation("succeeded"))).toBe(0);
  });

  it("heartbeats and cleans stream resources without aborting server-owned work", async () => {
    const broker = new OperationEventBroker();
    const findByOwner = vi.fn(async () => operation("processing"));
    const instance = await createApp({
      broker,
      access: { findAccessible: findByOwner },
      heartbeatIntervalMs: 10,
      statusPollIntervalMs: 10,
    });
    const address = await instance.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const response = await fetch(`${address}/api/v1/operations/${operationId}/events`, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error("SSE response has no body");
    }
    const firstChunk = new TextDecoder().decode((await reader.read()).value);
    expect(firstChunk).toContain(": heartbeat");
    expect(broker.listenerCount(operation("processing"))).toBe(1);

    let releaseWork: (() => void) | undefined;
    const workGate = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    const execution = new ServerOwnedOperationExecution().execute(async () => {
      await workGate;
      const completed = operation("succeeded");
      broker.publishTerminal(completed);
      return completed;
    });

    controller.abort();
    await waitUntil(() => broker.listenerCount(operation("processing")) === 0);
    const callsAfterCleanup = findByOwner.mock.calls.length;
    await delay(30);
    expect(findByOwner).toHaveBeenCalledTimes(callsAfterCleanup);

    releaseWork?.();
    await expect(execution).resolves.toMatchObject({ status: "succeeded" });
    expect(broker.history(operation("succeeded")).filter(isTerminal)).toHaveLength(1);
  });

  it("retries lazy expiry in a fresh repeatable-read read-write unit of work", async () => {
    const run = vi.fn(
      async (
        callback: (repositories: {
          accounts: { isSessionActive: () => Promise<boolean> };
          operations: { findById: () => Promise<StoredOperation> };
        }) => Promise<StoredOperation | null>,
        options: unknown,
      ) => {
        if (run.mock.calls.length === 1) {
          throw new RepositoryInterviewExpiredError("operation-event-interview", 1, 2, occurredAt);
        }
        expect(options).toEqual({
          isolationLevel: "repeatable read",
          accessMode: "read write",
        });
        return callback({
          accounts: { isSessionActive: async () => true },
          operations: { findById: async () => operation("failed") },
        });
      },
    );
    const dependencies = createOperationEventRouteDependencies(
      { run } as unknown as PgRepositoryUnitOfWork,
      new OperationEventBroker(),
    );

    await expect(
      dependencies.access.findAccessible(ownerId, authContext.sessionId, operationId),
    ).resolves.toMatchObject({ status: "failed" });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.map((call) => call[1])).toEqual([
      { isolationLevel: "repeatable read", accessMode: "read write" },
      { isolationLevel: "repeatable read", accessMode: "read write" },
    ]);
  });

  it("revalidates the original session before delivery without erasing other-session replay", async () => {
    const broker = new OperationEventBroker();
    let authorized = true;
    const findAccessible = vi.fn(async () => (authorized ? operation("processing") : null));
    const instance = await createApp({
      broker,
      access: {
        findAccessible,
        isSessionActive: async () => authorized,
      },
      heartbeatIntervalMs: 100,
      statusPollIntervalMs: 60_000,
    });
    const address = await instance.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/api/v1/operations/${operationId}/events`, {
      headers: { accept: "text/event-stream" },
    });
    expect(response.status).toBe(200);
    expect(broker.listenerCount(operation("processing"))).toBe(1);

    authorized = false;
    broker.publishTextDelta(operation("processing"), "会话撤销后不可泄露。", occurredAt);

    const body = await response.text();
    expect(body).not.toContain("会话撤销后不可泄露");
    expect(broker.history(operation("processing"))).toMatchObject([
      {
        type: "text_delta",
        text: "会话撤销后不可泄露。",
      },
    ]);
    expect(broker.listenerCount(operation("processing"))).toBe(0);
    expect(findAccessible).toHaveBeenCalledWith(ownerId, authContext.sessionId, operationId);
  });

  it("does not leak listeners when the client disconnects during initial access", async () => {
    const broker = new OperationEventBroker();
    let releaseLookup: (() => void) | undefined;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const findAccessible = vi.fn(async () => {
      await lookupGate;
      return operation("processing");
    });
    const instance = await createApp({
      broker,
      access: { findAccessible },
      heartbeatIntervalMs: 10,
      statusPollIntervalMs: 10,
    });
    const address = await instance.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const request = fetch(`${address}/api/v1/operations/${operationId}/events`, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    }).catch(() => null);

    await delay(10);
    controller.abort();
    releaseLookup?.();
    await request;
    await delay(30);

    expect(broker.listenerCount(operation("processing"))).toBe(0);
    expect(findAccessible).toHaveBeenCalledTimes(1);
  });

  it("prevents late publishers from recreating erased Operation history", () => {
    const broker = new OperationEventBroker();
    const target = operation("processing");
    broker.beginAttempt(target);
    broker.eraseOperation(target.id);

    expect(broker.publishTextDelta(target, "删除后不可保留。", occurredAt)).toBeNull();
    expect(broker.publishTerminal(operation("succeeded"))).toBeNull();
    expect(broker.history(target)).toEqual([]);
  });

  it("expires deletion tombstones without retaining identifiers indefinitely", async () => {
    const broker = new OperationEventBroker({ erasureTtlMs: 5 });
    const target = operation("processing");
    broker.eraseOperation(target.id);
    expect(broker.publishTextDelta(target, "删除窗口内不可恢复。", occurredAt)).toBeNull();

    await delay(10);

    expect(
      broker.publishTextDelta(target, "删除窗口后可复用进程内标识。", occurredAt),
    ).toMatchObject({
      sequence: 1,
      type: "text_delta",
    });
    broker.close();
  });

  it("closes active streams before graceful shutdown waits", async () => {
    const broker = new OperationEventBroker();
    const instance = await createApp({
      broker,
      access: { findAccessible: async () => operation("processing") },
      heartbeatIntervalMs: 10,
      statusPollIntervalMs: 60_000,
    });
    const address = await instance.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/api/v1/operations/${operationId}/events`, {
      headers: { accept: "text/event-stream" },
    });
    expect(response.status).toBe(200);
    expect(broker.listenerCount(operation("processing"))).toBe(1);

    await expect(
      Promise.race([instance.close().then(() => "closed"), delay(500).then(() => "timeout")]),
    ).resolves.toBe("closed");
    await expect(response.text()).resolves.not.toContain("succeeded");
    expect(broker.listenerCount(operation("processing"))).toBe(0);
  });
});

interface ParsedSseEvent {
  readonly id: string;
  readonly event: string;
  readonly data: OperationEventDto;
}

function parseSse(body: string): ParsedSseEvent[] {
  return body
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.length > 0 && !block.startsWith(":"))
    .map((block) => {
      const fields = new Map(
        block.split("\n").map((line) => {
          const separator = line.indexOf(":");
          return [line.slice(0, separator), line.slice(separator + 1).trim()] as const;
        }),
      );
      return {
        id: fields.get("id") ?? "",
        event: fields.get("event") ?? "",
        data: JSON.parse(fields.get("data") ?? "null") as OperationEventDto,
      };
    });
}

function isTerminal(event: OperationEventDto): boolean {
  return event.type === "succeeded" || event.type === "failed";
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) {
      return;
    }
    await delay(5);
  }
  throw new Error("Condition was not met");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
