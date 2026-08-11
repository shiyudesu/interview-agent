import {
  ConfirmDeletionRequestSchema,
  DeletionAcceptedResponseSchema,
  DeletionFailureResponseSchema,
} from "@interview-agent/contracts";
import { type InterviewId, parseInterviewId } from "@interview-agent/domain";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AuthenticatedRequestContext, Authentication } from "./auth.js";
import type { ServerConfig } from "./config.js";
import { type DeletionOrchestrationService, DeletionTargetNotFoundError } from "./deletion.js";

declare module "fastify" {
  interface FastifyRequest {
    authContext: AuthenticatedRequestContext | null;
  }
}

export interface RegisterApplicationInput {
  readonly authentication: Authentication;
  readonly config: Pick<ServerConfig, "auth">;
  readonly deletion: DeletionOrchestrationService;
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
    const session = await input.authentication.getSession(authenticationHeaders(request));
    request.authContext = session.context;
    forwardSetCookies(session.headers, reply);
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

  app.delete<{
    Params: { readonly interviewId: string };
    Body: { readonly confirmed: true };
  }>(
    "/api/v1/interviews/:interviewId",
    {
      schema: {
        body: ConfirmDeletionRequestSchema,
        response: {
          202: DeletionAcceptedResponseSchema,
          500: DeletionFailureResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const context = request.authContext;
      if (context === null) {
        return reply.code(401).send(unauthorizedResponse());
      }
      let interviewId: InterviewId;
      try {
        interviewId = parseInterviewId(request.params.interviewId);
      } catch {
        return reply.code(400).send({
          error: {
            code: "invalid_interview_id",
            message: "Interview ID is invalid",
          },
        });
      }
      try {
        const result = await input.deletion.deleteInterview(context.accountId, interviewId);
        return reply.code(202).send(deletionResponse(result));
      } catch (error) {
        if (error instanceof DeletionTargetNotFoundError) {
          return reply.code(404).send(notFoundResponse());
        }
        request.log.error(
          { event: "deletion_request_failed", scope: "interview" },
          "Deletion request failed",
        );
        return reply.code(500).send(deletionFailureResponse());
      }
    },
  );

  app.delete<{ Body: { readonly confirmed: true } }>(
    "/api/v1/account",
    {
      schema: {
        body: ConfirmDeletionRequestSchema,
        response: {
          202: DeletionAcceptedResponseSchema,
          500: DeletionFailureResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const context = request.authContext;
      if (context === null) {
        return reply.code(401).send(unauthorizedResponse());
      }
      try {
        const result = await input.deletion.deleteAccount(context.accountId);
        return reply.code(202).send(deletionResponse(result));
      } catch (error) {
        if (error instanceof DeletionTargetNotFoundError) {
          return reply.code(404).send(notFoundResponse());
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

function unauthorizedResponse() {
  return {
    error: {
      code: "unauthorized",
      message: "Authentication is required",
    },
  };
}

function notFoundResponse() {
  return {
    error: {
      code: "not_found",
      message: "Resource was not found",
    },
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
