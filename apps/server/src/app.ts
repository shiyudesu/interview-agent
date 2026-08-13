import {
  AccountDeletionNotFoundResponseSchema,
  type ConfirmDeletionRequestDto,
  ConfirmDeletionRequestSchema,
  DeletionAcceptedResponseSchema,
  DeletionServerFailureResponseSchema,
  DeletionUnauthorizedResponseSchema,
  DeletionValidationErrorResponseSchema,
  InterviewDeletionNotFoundResponseSchema,
  type InterviewDeletionParamsDto,
  InterviewDeletionParamsSchema,
} from "@interview-agent/contracts";
import { parseInterviewId } from "@interview-agent/domain";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { createApiRouteErrorHandler, internalError, notFoundError } from "./api-route-errors.js";
import type { Authentication } from "./auth.js";
import { authenticatedRequestContext } from "./authenticated-request.js";
import {
  type InterviewCommandRouteDependencies,
  registerInterviewCommandRoutes,
} from "./command-routes.js";
import type { ServerConfig } from "./config.js";
import { type DeletionOrchestrationService, DeletionTargetNotFoundError } from "./deletion.js";
import {
  type OperationEventRouteDependencies,
  registerOperationEventRoutes,
} from "./operation-events.js";
import { type CanonicalReadRouteDependencies, registerCanonicalReadRoutes } from "./read-routes.js";

export interface RegisterApplicationInput {
  readonly authentication: Authentication;
  readonly config: Pick<ServerConfig, "auth">;
  readonly deletion: DeletionOrchestrationService;
  readonly interviewCommands: InterviewCommandRouteDependencies;
  readonly canonicalReads: CanonicalReadRouteDependencies;
  readonly operationEvents: OperationEventRouteDependencies;
}

export async function registerApplication(
  app: FastifyInstance,
  input: RegisterApplicationInput,
): Promise<void> {
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => done(null, body),
  );
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request, reply) => {
    if (!isProtectedApiRequest(request.routeOptions.url)) {
      return;
    }
    try {
      const session = await input.authentication.getSession(authenticationHeaders(request));
      request.authContext = session.context;
      forwardSetCookies(session.headers, reply);
    } catch {
      request.log.error({ event: "authentication_session_failed" }, "Authentication failed");
      return reply.code(500).send(internalError());
    }
  });

  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async handler(request, reply) {
      try {
        const response = await input.authentication.handler(
          new Request(new URL(request.url, input.config.auth.baseUrl), {
            method: request.method,
            headers: authenticationHeaders(request),
            ...requestBody(request),
          }),
        );
        reply.code(response.status);
        response.headers.forEach((value, key) => {
          if (key.toLowerCase() !== "set-cookie") {
            reply.header(key, value);
          }
        });
        forwardSetCookies(response.headers, reply);
        const body = Buffer.from(await response.arrayBuffer());
        return reply.send(body.length === 0 ? null : body);
      } catch {
        request.log.error({ event: "authentication_request_failed" }, "Authentication failed");
        return reply.code(500).send({
          error: {
            code: "authentication_failure",
            message: "Authentication request failed",
          },
        });
      }
    },
  });

  await registerCanonicalReadRoutes(app, input.canonicalReads);
  await registerOperationEventRoutes(app, input.operationEvents);
  await registerInterviewCommandRoutes(app, input.interviewCommands);

  app.delete<{
    Params: InterviewDeletionParamsDto;
    Body: ConfirmDeletionRequestDto;
  }>(
    "/api/v1/interviews/:interviewId",
    {
      schema: {
        params: InterviewDeletionParamsSchema,
        body: ConfirmDeletionRequestSchema,
        response: {
          400: DeletionValidationErrorResponseSchema,
          401: DeletionUnauthorizedResponseSchema,
          404: InterviewDeletionNotFoundResponseSchema,
          202: DeletionAcceptedResponseSchema,
          500: DeletionServerFailureResponseSchema,
        },
      },
      errorHandler: deletionRouteErrorHandler,
    },
    async (request, reply) => {
      const context = authenticatedRequestContext(request, reply);
      if (context === null) {
        return;
      }
      const interviewId = parseInterviewId(request.params.interviewId);
      try {
        const result = await input.deletion.deleteInterview(context.accountId, interviewId);
        eraseDeletedOperationEvents(request, input.operationEvents.broker, () =>
          input.operationEvents.broker.eraseInterview(context.accountId, interviewId),
        );
        return reply.code(202).send(deletionResponse(result));
      } catch (error) {
        if (error instanceof DeletionTargetNotFoundError) {
          return reply.code(404).send(notFoundError("interview"));
        }
        request.log.error(
          { event: "deletion_request_failed", scope: "interview" },
          "Deletion request failed",
        );
        return reply.code(500).send(deletionFailureResponse());
      }
    },
  );

  app.delete<{ Body: ConfirmDeletionRequestDto }>(
    "/api/v1/account",
    {
      schema: {
        body: ConfirmDeletionRequestSchema,
        response: {
          400: DeletionValidationErrorResponseSchema,
          401: DeletionUnauthorizedResponseSchema,
          404: AccountDeletionNotFoundResponseSchema,
          202: DeletionAcceptedResponseSchema,
          500: DeletionServerFailureResponseSchema,
        },
      },
      errorHandler: deletionRouteErrorHandler,
    },
    async (request, reply) => {
      const context = authenticatedRequestContext(request, reply);
      if (context === null) {
        return;
      }
      try {
        const result = await input.deletion.deleteAccount(context.accountId);
        eraseDeletedOperationEvents(request, input.operationEvents.broker, () =>
          input.operationEvents.broker.eraseAccount(context.accountId),
        );
        return reply.code(202).send(deletionResponse(result));
      } catch (error) {
        if (error instanceof DeletionTargetNotFoundError) {
          return reply.code(404).send(notFoundError("account"));
        }
        request.log.error(
          { event: "deletion_request_failed", scope: "account" },
          "Deletion request failed",
        );
        return reply.code(500).send(deletionFailureResponse());
      }
    },
  );
}

function eraseDeletedOperationEvents(
  request: FastifyRequest,
  broker: RegisterApplicationInput["operationEvents"]["broker"],
  erase: () => void,
): void {
  try {
    erase();
  } catch {
    request.log.error(
      { event: "operation_event_erasure_failed" },
      "Operation event erasure failed; closing broker",
    );
    broker.close();
  }
}

function isProtectedApiRequest(routeUrl: string | undefined): boolean {
  return routeUrl !== undefined && (routeUrl === "/api/v1" || routeUrl.startsWith("/api/v1/"));
}

function requestBody(request: FastifyRequest): Pick<RequestInit, "body"> | object {
  if (request.method === "GET" || request.method === "HEAD" || request.body === undefined) {
    return {};
  }
  if (
    typeof request.body === "string" ||
    request.body instanceof URLSearchParams ||
    request.body instanceof Blob ||
    request.body instanceof FormData ||
    request.body instanceof ArrayBuffer ||
    ArrayBuffer.isView(request.body)
  ) {
    return { body: request.body };
  }
  return { body: JSON.stringify(request.body) };
}

function authenticationHeaders(request: FastifyRequest): Headers {
  const headers = fromNodeHeaders(request.headers);
  headers.set("x-interview-client-ip", request.ip);
  return headers;
}

function forwardSetCookies(headers: Headers, reply: FastifyReply): void {
  const setCookies = headers.getSetCookie();
  if (setCookies.length > 0) {
    reply.header("set-cookie", setCookies);
  }
}

function deletionResponse(result: { readonly requestedAt: Date; readonly purgeDeadlineAt: Date }) {
  return {
    status: "deleting" as const,
    requestedAt: result.requestedAt.toISOString(),
    purgeDeadlineAt: result.purgeDeadlineAt.toISOString(),
  };
}

function deletionFailureResponse() {
  return {
    error: {
      code: "deletion_failure",
      message: "Deletion request failed",
    },
  };
}

const deletionRouteErrorHandler = createApiRouteErrorHandler({
  logEvent: "deletion_route_failed",
  logMessage: "Deletion route failed",
  mapContentTypeParserErrors: true,
  unexpectedError: deletionFailureResponse,
});
