import type {
  AccountResponseDto,
  CurrentInterviewResponseDto,
  InterviewDetailResponseDto,
  InterviewHistoryResponseDto,
  OperationStatusResponseDto,
  ReportResponseDto,
} from "@interview-agent/contracts";
import type { PgRepositoryUnitOfWork } from "@interview-agent/db";
import { parseAccountId, parseInterviewId, parseOperationId } from "@interview-agent/domain";
import type { BetterAuthOptions } from "better-auth";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerApplication } from "../src/app.js";
import type { AuthenticatedRequestContext, Authentication } from "../src/auth.js";
import type { InterviewCommandRouteDependencies } from "../src/command-routes.js";
import { DeletionOrchestrationService } from "../src/deletion.js";
import {
  type CanonicalReadRouteDependencies,
  createCanonicalReadRouteDependencies,
  InvalidHistoryCursorError,
} from "../src/read-routes.js";

const apps: ReturnType<typeof Fastify>[] = [];
const accountId = parseAccountId("read-route-owner");
const authContext: AuthenticatedRequestContext = {
  accountId,
  sessionId: "session-current",
  email: "candidate@example.test",
  name: "Candidate",
};
const occurredAt = "2026-08-12T04:00:00.000Z";
const later = "2026-08-12T05:00:00.000Z";
const config = {
  auth: {
    secret: "0123456789abcdef0123456789abcdef",
    baseUrl: "http://localhost:3000",
  },
} as const;

const accountResponse: AccountResponseDto = {
  id: "read-route-owner",
  email: "candidate@example.test",
  displayName: "Candidate",
  linkedIdentities: [
    {
      provider: "email_otp",
      providerAccountId: "candidate@example.test",
      linkedAt: occurredAt,
    },
  ],
  sessions: [
    {
      id: "session-current",
      expiresAt: later,
      createdAt: occurredAt,
      updatedAt: later,
      ipAddress: null,
      userAgent: null,
      current: true,
    },
  ],
  createdAt: occurredAt,
} as unknown as AccountResponseDto;

const activeInterviewResponse: CurrentInterviewResponseDto = {
  id: "active-interview",
  status: "active",
  phase: "awaiting_response",
  version: 3,
  progress: { current: 1, total: 5 },
  currentWording: "请解释 context.Context 的用途。",
  messages: [],
  startedAt: occurredAt,
  lastEffectiveActivityAt: occurredAt,
  expiresAt: "2026-08-13T04:00:00.000Z",
  availableActions: ["submit_answer", "request_clarification", "mark_unknown", "skip", "abandon"],
} as unknown as CurrentInterviewResponseDto;

const interviewDetailResponse: InterviewDetailResponseDto = {
  id: "history-interview",
  status: "abandoned",
  version: 4,
  questionCount: 5,
  startedAt: occurredAt,
  endedAt: later,
  messages: [],
} as unknown as InterviewDetailResponseDto;

const operationResponse: OperationStatusResponseDto = {
  operationId: "operation-1",
  status: "processing",
  createdAt: occurredAt,
  updatedAt: later,
} as unknown as OperationStatusResponseDto;

const historyResponse: InterviewHistoryResponseDto = {
  items: [
    {
      id: "history-interview",
      status: "abandoned",
      direction: "go_backend",
      questionCount: 5,
      startedAt: occurredAt,
      endedAt: later,
    },
  ],
  pageInfo: {
    nextCursor: "next-page",
    hasMore: true,
  },
} as unknown as InterviewHistoryResponseDto;

const reportResponse: ReportResponseDto = {
  kind: "incomplete",
  reportId: "report-1",
  interviewId: "history-interview",
  generatedAt: later,
  domains: [
    { status: "assessed", domain: "go_language", score: 0, questionCount: 1 },
    { status: "unassessed", domain: "concurrency_runtime_performance" },
    { status: "unassessed", domain: "http_rpc_api" },
    { status: "unassessed", domain: "database_storage" },
    { status: "unassessed", domain: "cache_messaging_distributed" },
    { status: "unassessed", domain: "testing_observability_engineering" },
  ],
  questions: [
    {
      position: 1,
      displayedQuestion: "请解释 context.Context 的用途。",
      answerSummary: "用户表示不了解。",
      outcome: "unknown",
      score: 0,
      zeroScoreReason: "unknown",
      matchedKnowledgePoints: [],
      missingOrIncorrectPoints: ["取消传播"],
      scoreRationale: "用户明确表示不了解。",
      improvementSuggestions: ["学习 Context 的取消传播。"],
    },
  ],
  overallExplanation: "本次面试提前结束。",
  strengths: ["如实表达未知内容。"],
  weaknesses: ["Context 基础不足。"],
  priorities: ["优先学习 Context。"],
  learningSuggestions: ["阅读 Context 官方文档。"],
} as unknown as ReportResponseDto;

function authentication(context: AuthenticatedRequestContext | null): Authentication {
  const options: BetterAuthOptions = {};
  return {
    handler: async () => new Response(null, { status: 404 }),
    options,
    getSession: async () => ({ context, headers: new Headers() }),
  };
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
    states: { findById: async () => null },
    now: () => new Date(occurredAt),
    nextInterviewId: () => parseInterviewId("generated-interview"),
    nextOperationId: () => parseOperationId("generated-operation"),
  };
}

function deletion() {
  return new DeletionOrchestrationService({
    markInterviewDeleting: async () => null,
    markAccountDeleting: async () => null,
  });
}

function canonicalReads(): CanonicalReadRouteDependencies {
  return {
    currentAccount: vi.fn(async () => accountResponse),
    activeInterview: vi.fn(async () => activeInterviewResponse),
    interviewDetail: vi.fn(async () => interviewDetailResponse),
    operationStatus: vi.fn(async () => operationResponse),
    interviewHistory: vi.fn(async () => historyResponse),
    reportDetail: vi.fn(async () => reportResponse),
  };
}

async function createApp(
  reads: CanonicalReadRouteDependencies,
  context: AuthenticatedRequestContext | null = authContext,
) {
  const instance = Fastify({ logger: false });
  apps.push(instance);
  await registerApplication(instance, {
    authentication: authentication(context),
    config,
    deletion: deletion(),
    interviewCommands: interviewCommands(),
    canonicalReads: reads,
  });
  return instance;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((instance) => instance.close()));
});

describe("canonical read routes", () => {
  it("serves all six authenticated canonical resources through owner-scoped dependencies", async () => {
    const reads = canonicalReads();
    const instance = await createApp(reads);
    const responses = await Promise.all([
      instance.inject({ method: "GET", url: "/api/v1/account" }),
      instance.inject({ method: "GET", url: "/api/v1/interviews/active" }),
      instance.inject({ method: "GET", url: "/api/v1/interviews/history-interview" }),
      instance.inject({ method: "GET", url: "/api/v1/operations/operation-1" }),
      instance.inject({
        method: "GET",
        url: "/api/v1/interviews?limit=2&cursor=opaque-cursor",
      }),
      instance.inject({
        method: "GET",
        url: "/api/v1/interviews/history-interview/report",
      }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([
      200, 200, 200, 200, 200, 200,
    ]);
    expect(responses.map((response) => response.json())).toEqual([
      accountResponse,
      activeInterviewResponse,
      interviewDetailResponse,
      operationResponse,
      historyResponse,
      reportResponse,
    ]);
    expect(reads.currentAccount).toHaveBeenCalledWith(accountId, authContext.sessionId);
    expect(reads.activeInterview).toHaveBeenCalledWith(accountId);
    expect(reads.interviewDetail).toHaveBeenCalledWith(
      accountId,
      parseInterviewId("history-interview"),
    );
    expect(reads.operationStatus).toHaveBeenCalledWith(accountId, parseOperationId("operation-1"));
    expect(reads.interviewHistory).toHaveBeenCalledWith(accountId, {
      limit: 2,
      cursor: "opaque-cursor",
    });
    expect(reads.reportDetail).toHaveBeenCalledWith(
      accountId,
      parseInterviewId("history-interview"),
    );
  });

  it("returns the same stable 404 for absent and non-owned resources", async () => {
    const reads = canonicalReads();
    reads.currentAccount = vi.fn(async () => null);
    reads.activeInterview = vi.fn(async () => null);
    reads.interviewDetail = vi.fn(async () => null);
    reads.operationStatus = vi.fn(async () => null);
    reads.reportDetail = vi.fn(async () => null);
    const instance = await createApp(reads);

    for (const [url, resource] of [
      ["/api/v1/account", "account"],
      ["/api/v1/interviews/active", "interview"],
      ["/api/v1/interviews/other-owner", "interview"],
      ["/api/v1/operations/other-owner", "operation"],
      ["/api/v1/interviews/other-owner/report", "report"],
    ] as const) {
      const response = await instance.inject({ method: "GET", url });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: {
          code: "not_found",
          message: "Resource was not found.",
          resource,
        },
      });
    }
  });

  it("requires authentication before invoking any read dependency", async () => {
    const reads = canonicalReads();
    const instance = await createApp(reads, null);

    for (const url of [
      "/api/v1/account",
      "/api/v1/interviews/active",
      "/api/v1/interviews/interview-1",
      "/api/v1/operations/operation-1",
      "/api/v1/interviews",
      "/api/v1/interviews/interview-1/report",
    ]) {
      const response = await instance.inject({ method: "GET", url });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: {
          code: "unauthorized",
          message: "Authentication is required",
        },
      });
    }
    expect(
      Object.values(reads).every((dependency) => vi.mocked(dependency).mock.calls.length === 0),
    ).toBe(true);
  });

  it("returns stable validation envelopes for invalid params, bounds, and cursors", async () => {
    const reads = canonicalReads();
    reads.interviewHistory = vi.fn(async () => {
      throw new InvalidHistoryCursorError();
    });
    const instance = await createApp(reads);

    const invalidId = await instance.inject({
      method: "GET",
      url: "/api/v1/operations/not%20valid",
    });
    const invalidLimit = await instance.inject({
      method: "GET",
      url: "/api/v1/interviews?limit=101",
    });
    const invalidCursor = await instance.inject({
      method: "GET",
      url: "/api/v1/interviews?cursor=invalid",
    });

    for (const response of [invalidId, invalidLimit, invalidCursor]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: {
          code: "validation_error",
          message: "The request is invalid.",
        },
      });
    }
    expect(invalidCursor.json()).toEqual({
      error: {
        code: "validation_error",
        message: "The request is invalid.",
        issues: [
          {
            path: "/query/cursor",
            code: "invalid_cursor",
            message: "The history cursor is invalid.",
          },
        ],
      },
    });
  });

  describe("canonical read dependency composition", () => {
    it("creates and consumes a bounded opaque history cursor", async () => {
      const entries = [
        {
          interviewId: parseInterviewId("history-newer"),
          createdAt: new Date("2026-08-12T03:00:00.000Z"),
          endedAt: new Date("2026-08-12T04:00:00.000Z"),
          direction: "go_backend" as const,
          questionCount: 5 as const,
          status: "abandoned" as const,
          overallScore: null,
          reportId: null,
        },
        {
          interviewId: parseInterviewId("history-older"),
          createdAt: new Date("2026-08-12T01:00:00.000Z"),
          endedAt: new Date("2026-08-12T02:00:00.000Z"),
          direction: "go_backend" as const,
          questionCount: 5 as const,
          status: "abandoned" as const,
          overallScore: null,
          reportId: null,
        },
      ];
      const listHistory = vi
        .fn()
        .mockResolvedValueOnce(entries)
        .mockResolvedValueOnce([entries[1]]);
      const unitOfWork = {
        run: async (callback: (repositories: unknown) => Promise<unknown>) =>
          callback({
            interviews: { listHistory },
          }),
      } as unknown as PgRepositoryUnitOfWork;
      const reads = createCanonicalReadRouteDependencies(unitOfWork);

      const first = await reads.interviewHistory(accountId, { limit: 1 });
      expect(first.pageInfo.hasMore).toBe(true);
      expect(first.pageInfo.nextCursor).not.toBeNull();
      expect(listHistory).toHaveBeenNthCalledWith(1, accountId, 2, undefined);
      if (first.pageInfo.nextCursor === null) {
        throw new Error("Expected next history cursor");
      }

      await reads.interviewHistory(accountId, {
        limit: 1,
        cursor: first.pageInfo.nextCursor,
      });
      expect(listHistory).toHaveBeenNthCalledWith(2, accountId, 2, {
        endedAt: entries[0]?.endedAt,
        interviewId: entries[0]?.interviewId,
      });
    });

    it("rejects malformed opaque cursors before touching PostgreSQL", async () => {
      const run = vi.fn();
      const reads = createCanonicalReadRouteDependencies({
        run,
      } as unknown as PgRepositoryUnitOfWork);

      await expect(
        reads.interviewHistory(accountId, { cursor: "not-a-valid-cursor" }),
      ).rejects.toBeInstanceOf(InvalidHistoryCursorError);
      expect(run).not.toHaveBeenCalled();
    });
  });

  it("sanitizes repository and mapping failures", async () => {
    const reads = canonicalReads();
    reads.interviewDetail = vi.fn(async () => {
      throw new Error("postgres password=secret and answer contents");
    });
    const instance = await createApp(reads);

    const response = await instance.inject({
      method: "GET",
      url: "/api/v1/interviews/interview-1",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: "internal_error",
        message: "An unexpected error occurred.",
      },
    });
    expect(response.body).not.toContain("secret");
    expect(response.body).not.toContain("answer contents");
  });
});
