import { createHash } from "node:crypto";

import {
  AccountNotFoundErrorResponseSchema,
  type AccountResponseDto,
  AccountResponseSchema,
  type CurrentInterviewResponseDto,
  CurrentInterviewResponseSchema,
  InternalErrorResponseSchema,
  type InterviewDetailResponseDto,
  InterviewDetailResponseSchema,
  type InterviewHistoryResponseDto,
  InterviewHistoryResponseSchema,
  InterviewNotFoundErrorResponseSchema,
  type InterviewReadParamsDto,
  InterviewReadParamsSchema,
  mapAccountAccessToResponse,
  mapInternalReportSnapshotToPublic,
  mapInterviewHistoryToResponse,
  mapInterviewToResponse,
  mapOperationToStatusResponse,
  OperationNotFoundErrorResponseSchema,
  type OperationReadParamsDto,
  OperationReadParamsSchema,
  type OperationStatusResponseDto,
  OperationStatusResponseSchema,
  type PaginationQueryDto,
  PaginationQuerySchema,
  type PublicOperationProjection,
  ReportNotFoundErrorResponseSchema,
  type ReportResponseDto,
  ReportResponseSchema,
  UnauthorizedErrorResponseSchema,
  ValidationErrorResponseSchema,
} from "@interview-agent/contracts";
import type {
  InterviewDetail,
  InterviewHistoryCursor,
  PgRepositoryUnitOfWork,
  StoredOperation,
} from "@interview-agent/db";
import {
  type AccountId,
  type Interview,
  type InterviewId,
  parseInterviewId,
  parseMessageId,
  parseOperationId,
} from "@interview-agent/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { createApiRouteErrorHandler, internalError, notFoundError } from "./api-route-errors.js";
import { authenticatedRequestContext } from "./authenticated-request.js";
import { retryAfterRepositoryInterviewExpiry } from "./repository-interview-expiry.js";

const DEFAULT_HISTORY_LIMIT = 20;
const HISTORY_CURSOR_VERSION = 1;
const CANONICAL_READ_TRANSACTION = {
  isolationLevel: "repeatable read",
  accessMode: "read only",
} as const;
const CANONICAL_STATE_TRANSACTION = {
  isolationLevel: "repeatable read",
  accessMode: "read write",
} as const;

const readRouteErrorHandler = createApiRouteErrorHandler({
  logEvent: "canonical_read_route_failed",
  logMessage: "Canonical read route failed",
  mapContentTypeParserErrors: false,
});

export interface CanonicalReadRouteDependencies {
  currentAccount(accountId: AccountId, sessionId: string): Promise<AccountResponseDto | null>;
  activeInterview(accountId: AccountId): Promise<CurrentInterviewResponseDto | null>;
  interviewDetail(
    accountId: AccountId,
    interviewId: InterviewId,
  ): Promise<InterviewDetailResponseDto | null>;
  operationStatus(
    accountId: AccountId,
    operationId: ReturnType<typeof parseOperationId>,
  ): Promise<OperationStatusResponseDto | null>;
  interviewHistory(
    accountId: AccountId,
    query: PaginationQueryDto,
  ): Promise<InterviewHistoryResponseDto>;
  reportDetail(accountId: AccountId, interviewId: InterviewId): Promise<ReportResponseDto | null>;
}

export class InvalidHistoryCursorError extends Error {
  constructor() {
    super("Interview history cursor is invalid");
    this.name = "InvalidHistoryCursorError";
  }
}

export function createCanonicalReadRouteDependencies(
  unitOfWork: PgRepositoryUnitOfWork,
): CanonicalReadRouteDependencies {
  return {
    currentAccount: (accountId, sessionId) =>
      unitOfWork.run(async (repositories) => {
        const account = await repositories.accounts.findAccountAccess(accountId, sessionId);
        return account === null ? null : mapAccountAccessToResponse(account);
      }, CANONICAL_READ_TRANSACTION),

    activeInterview: (accountId) =>
      retryAfterRepositoryInterviewExpiry(() =>
        unitOfWork.run(async (repositories) => {
          const interview = await repositories.interviews.findActiveByAccountId(accountId);
          if (interview === null) {
            return null;
          }
          const detail = await repositories.interviews.findDetailByOwner(interview.id, accountId);
          if (detail === null) {
            return null;
          }
          const response = await mapInterviewDetail(repositories, detail);
          if (response.status !== "active" && response.status !== "report_pending") {
            throw new Error("Active interview projection resolved to a terminal state");
          }
          return response;
        }, CANONICAL_STATE_TRANSACTION),
      ),

    interviewDetail: (accountId, interviewId) =>
      retryAfterRepositoryInterviewExpiry(() =>
        unitOfWork.run(async (repositories) => {
          const detail = await repositories.interviews.findDetailByOwner(interviewId, accountId);
          return detail === null ? null : mapInterviewDetail(repositories, detail);
        }, CANONICAL_STATE_TRANSACTION),
      ),

    operationStatus: (accountId, operationId) =>
      retryAfterRepositoryInterviewExpiry(() =>
        unitOfWork.run(async (repositories) => {
          const operation = await repositories.operations.findById(operationId, accountId);
          return operation === null ? null : mapOperationToStatusResponse(operation);
        }, CANONICAL_STATE_TRANSACTION),
      ),

    interviewHistory: async (accountId, query) => {
      const limit = query.limit ?? DEFAULT_HISTORY_LIMIT;
      const before = query.cursor === undefined ? undefined : decodeHistoryCursor(query.cursor);
      return await unitOfWork.run(async (repositories) => {
        const entries = await repositories.interviews.listHistory(accountId, limit + 1, before);
        const hasMore = entries.length > limit;
        const page = entries.slice(0, limit);
        const last = page.at(-1);
        return mapInterviewHistoryToResponse(page, {
          hasMore,
          nextCursor: hasMore && last !== undefined ? encodeHistoryCursor(last) : null,
        });
      }, CANONICAL_READ_TRANSACTION);
    },

    reportDetail: (accountId, interviewId) =>
      retryAfterRepositoryInterviewExpiry(() =>
        unitOfWork.run(async (repositories) => {
          const report = await repositories.reports.findByInterviewId(interviewId, accountId);
          return report === null ? null : mapInternalReportSnapshotToPublic(report.snapshot);
        }, CANONICAL_STATE_TRANSACTION),
      ),
  };
}

export async function registerCanonicalReadRoutes(
  app: FastifyInstance,
  dependencies: CanonicalReadRouteDependencies,
): Promise<void> {
  app.get(
    "/api/v1/account",
    readRouteOptions(AccountResponseSchema, "Get the current account", "Account", {
      404: AccountNotFoundErrorResponseSchema,
    }),
    async (request, reply) => {
      const context = authenticatedRequestContext(request, reply);
      if (context === null) {
        return;
      }
      return sendRead(request, reply, "account", () =>
        dependencies.currentAccount(context.accountId, context.sessionId),
      );
    },
  );

  app.get(
    "/api/v1/interviews/active",
    readRouteOptions(CurrentInterviewResponseSchema, "Get the active interview", "Interviews", {
      404: InterviewNotFoundErrorResponseSchema,
    }),
    async (request, reply) => {
      const context = authenticatedRequestContext(request, reply);
      if (context === null) {
        return;
      }
      return sendRead(request, reply, "interview", () =>
        dependencies.activeInterview(context.accountId),
      );
    },
  );

  app.get<{ Params: InterviewReadParamsDto }>(
    "/api/v1/interviews/:interviewId",
    {
      ...readRouteOptions(InterviewDetailResponseSchema, "Get interview detail", "Interviews", {
        400: ValidationErrorResponseSchema,
        404: InterviewNotFoundErrorResponseSchema,
      }),
      schema: {
        ...readRouteOptions(InterviewDetailResponseSchema, "Get interview detail", "Interviews", {
          400: ValidationErrorResponseSchema,
          404: InterviewNotFoundErrorResponseSchema,
        }).schema,
        params: InterviewReadParamsSchema,
      },
    },
    async (request, reply) => {
      const context = authenticatedRequestContext(request, reply);
      if (context === null) {
        return;
      }
      return sendRead(request, reply, "interview", () =>
        dependencies.interviewDetail(
          context.accountId,
          parseInterviewId(request.params.interviewId),
        ),
      );
    },
  );

  app.get<{ Params: OperationReadParamsDto }>(
    "/api/v1/operations/:operationId",
    {
      ...readRouteOptions(OperationStatusResponseSchema, "Get Operation status", "Operations", {
        400: ValidationErrorResponseSchema,
        404: OperationNotFoundErrorResponseSchema,
      }),
      schema: {
        ...readRouteOptions(OperationStatusResponseSchema, "Get Operation status", "Operations", {
          400: ValidationErrorResponseSchema,
          404: OperationNotFoundErrorResponseSchema,
        }).schema,
        params: OperationReadParamsSchema,
      },
    },
    async (request, reply) => {
      const context = authenticatedRequestContext(request, reply);
      if (context === null) {
        return;
      }
      return sendRead(request, reply, "operation", () =>
        dependencies.operationStatus(
          context.accountId,
          parseOperationId(request.params.operationId),
        ),
      );
    },
  );

  app.get<{ Querystring: PaginationQueryDto }>(
    "/api/v1/interviews",
    {
      ...readRouteOptions(InterviewHistoryResponseSchema, "List interview history", "Interviews", {
        400: ValidationErrorResponseSchema,
      }),
      schema: {
        ...readRouteOptions(
          InterviewHistoryResponseSchema,
          "List interview history",
          "Interviews",
          {
            400: ValidationErrorResponseSchema,
          },
        ).schema,
        querystring: PaginationQuerySchema,
      },
    },
    async (request, reply) => {
      const context = authenticatedRequestContext(request, reply);
      if (context === null) {
        return;
      }
      return sendRead(request, reply, null, () =>
        dependencies.interviewHistory(context.accountId, request.query),
      );
    },
  );

  app.get<{ Params: InterviewReadParamsDto }>(
    "/api/v1/interviews/:interviewId/report",
    {
      ...readRouteOptions(
        ReportResponseSchema,
        "Get the immutable interview report",
        "Interviews",
        {
          400: ValidationErrorResponseSchema,
          404: ReportNotFoundErrorResponseSchema,
        },
      ),
      schema: {
        ...readRouteOptions(
          ReportResponseSchema,
          "Get the immutable interview report",
          "Interviews",
          {
            400: ValidationErrorResponseSchema,
            404: ReportNotFoundErrorResponseSchema,
          },
        ).schema,
        params: InterviewReadParamsSchema,
      },
    },
    async (request, reply) => {
      const context = authenticatedRequestContext(request, reply);
      if (context === null) {
        return;
      }
      return sendRead(request, reply, "report", () =>
        dependencies.reportDetail(context.accountId, parseInterviewId(request.params.interviewId)),
      );
    },
  );
}

async function mapInterviewDetail(
  repositories: Parameters<Parameters<PgRepositoryUnitOfWork["run"]>[0]>[0],
  detail: InterviewDetail,
): Promise<InterviewDetailResponseDto> {
  const operation =
    detail.interview.status === "completed" ||
    detail.interview.status === "early_ended" ||
    detail.interview.status === "abandoned" ||
    detail.interview.status === "deleting"
      ? null
      : await repositories.operations.findLatestIncompleteByInterviewId(
          detail.interview.id,
          detail.interview.accountId,
        );
  return mapInterviewToResponse(detail.interview, {
    messages: publicTranscriptMessages(detail),
    operation: publicInterviewOperation(detail.interview, operation),
    endedAt: detail.endedAt,
  });
}

function publicTranscriptMessages(detail: InterviewDetail) {
  return detail.questions.flatMap((question) => [
    {
      id: parseMessageId(
        `main-question-${createHash("sha256")
          .update(`${detail.interview.id}:${question.position}`)
          .digest("hex")
          .slice(0, 32)}`,
      ),
      questionPosition: question.position,
      role: "interviewer" as const,
      kind: "main_question" as const,
      text: question.displayedQuestion,
      createdAt: question.revealedAt,
    },
    ...question.messages.map((message) => ({
      id: parseMessageId(message.id),
      questionPosition: question.position,
      role: message.role === "user" ? ("user" as const) : ("interviewer" as const),
      kind: publicMessageKind(message.kind),
      text: message.content,
      createdAt: message.createdAt,
    })),
  ]);
}

function publicInterviewOperation(
  interview: Interview,
  operation: StoredOperation | null,
): PublicOperationProjection | null {
  if (operation === null) {
    return null;
  }
  if (interview.status === "active") {
    if (
      operation.type === "create_interview" &&
      (operation.status === "pending" || operation.status === "processing")
    ) {
      return operationReference(operation);
    }
    if (interview.phase === "processing") {
      if (interview.pendingOperation?.operationId !== operation.id) {
        return null;
      }
    } else if (
      operation.status !== "failed" ||
      hasFailureClassification(operation.error) ||
      !operationMatchesActivity(operation, interview.lastEffectiveActivityAt)
    ) {
      return null;
    }
  } else if (interview.status === "report_pending") {
    if (operation.type !== "generate_report") {
      return null;
    }
  } else {
    return null;
  }

  return operationReference(operation);
}

function operationReference(operation: StoredOperation): PublicOperationProjection | null {
  const mapped = mapOperationToStatusResponse(operation);
  if (mapped.status === "pending" || mapped.status === "processing") {
    return {
      operationId: parseOperationId(mapped.operationId),
      status: mapped.status,
    };
  }
  if (mapped.status === "failed") {
    return {
      operationId: parseOperationId(mapped.operationId),
      status: "failed",
      failure: mapped.failure,
    };
  }
  return null;
}

function hasFailureClassification(error: StoredOperation["error"]): boolean {
  return (error as { readonly classification?: unknown } | null)?.classification !== undefined;
}

function operationMatchesActivity(operation: StoredOperation, activityAt: Date): boolean {
  const activityTime = activityAt.getTime();
  return (
    operation.createdAt.getTime() === activityTime ||
    operation.lastAttemptAt?.getTime() === activityTime
  );
}

function publicMessageKind(
  kind: InterviewDetail["questions"][number]["messages"][number]["kind"],
): "main_question" | "answer" | "supplement" | "clarification" | "follow_up" | "transition" {
  switch (kind) {
    case "main_question":
      return "main_question";
    case "main_answer":
    case "follow_up_answer":
      return "answer";
    case "supplement":
      return "supplement";
    case "question_clarification":
      return "clarification";
    case "system_follow_up":
      return "follow_up";
    case "transition":
      return "transition";
  }
}

function encodeHistoryCursor(entry: {
  readonly endedAt: Date;
  readonly interviewId: InterviewId;
}): string {
  return Buffer.from(
    JSON.stringify({
      version: HISTORY_CURSOR_VERSION,
      endedAt: entry.endedAt.toISOString(),
      interviewId: String(entry.interviewId),
    }),
  ).toString("base64url");
}

function decodeHistoryCursor(cursor: string): InterviewHistoryCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new Error("Cursor is not Base64URL");
    }
    const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      decoded === null ||
      typeof decoded !== "object" ||
      Array.isArray(decoded) ||
      Object.keys(decoded).sort().join(",") !== "endedAt,interviewId,version"
    ) {
      throw new Error("Cursor shape is invalid");
    }
    const record = decoded as {
      readonly version?: unknown;
      readonly endedAt?: unknown;
      readonly interviewId?: unknown;
    };
    if (
      record.version !== HISTORY_CURSOR_VERSION ||
      typeof record.endedAt !== "string" ||
      typeof record.interviewId !== "string"
    ) {
      throw new Error("Cursor values are invalid");
    }
    const endedAt = new Date(record.endedAt);
    if (Number.isNaN(endedAt.getTime()) || endedAt.toISOString() !== record.endedAt) {
      throw new Error("Cursor timestamp is invalid");
    }
    return {
      endedAt,
      interviewId: parseInterviewId(record.interviewId),
    };
  } catch {
    throw new InvalidHistoryCursorError();
  }
}

function readRouteOptions(
  successSchema: object,
  summary: string,
  tag: "Account" | "Interviews" | "Operations" = "Interviews",
  statusSchemas: Readonly<Record<number, object>> = {},
) {
  return {
    schema: {
      tags: [tag],
      summary,
      response: {
        200: successSchema,
        ...statusSchemas,
        401: UnauthorizedErrorResponseSchema,
        500: InternalErrorResponseSchema,
      },
    },
    errorHandler: readRouteErrorHandler,
  };
}

async function sendRead<Response>(
  request: FastifyRequest,
  reply: FastifyReply,
  missingResource: "account" | "interview" | "operation" | "report" | null,
  load: () => Promise<Response | null>,
) {
  try {
    const response = await load();
    if (response === null && missingResource !== null) {
      return reply.code(404).send(notFoundError(missingResource));
    }
    return reply.code(200).send(response);
  } catch (error) {
    if (error instanceof InvalidHistoryCursorError) {
      return reply.code(400).send(invalidCursor());
    }
    request.log.error({ event: "canonical_read_failed" }, "Canonical read failed");
    return reply.code(500).send(internalError());
  }
}

function invalidCursor() {
  return {
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
  };
}
