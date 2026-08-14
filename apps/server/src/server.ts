import { randomUUID } from "node:crypto";

import { type TypeBoxTypeProvider, TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
  LogController,
} from "fastify";

const TRACEPARENT_PATTERN = /^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/u;

export const LOG_REDACTION_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers.x-api-key",
  "res.headers.set-cookie",
  "headers.authorization",
  "headers.cookie",
  "headers.set-cookie",
  "body",
  "request.body",
  "response.body",
  "password",
  "otp",
  "code",
  "token",
  "sessionToken",
  "accessToken",
  "refreshToken",
  "apiKey",
  "authorization",
  "cookie",
  "answer",
  "answerText",
  "text",
  "content",
  "*.password",
  "*.otp",
  "*.code",
  "*.token",
  "*.sessionToken",
  "*.accessToken",
  "*.refreshToken",
  "*.apiKey",
  "*.answer",
  "*.answerText",
  "*.text",
  "*.content",
] as const;

export function createLoggerOptions(level: string) {
  return {
    level,
    redact: {
      paths: [...LOG_REDACTION_PATHS],
      censor: "[REDACTED]",
    },
    serializers: {
      err(error: unknown) {
        return {
          type: error instanceof Error ? error.name : "Error",
          message: "[REDACTED]",
          stack: "[REDACTED]",
        };
      },
      req(request: unknown) {
        if (typeof request !== "object" || request === null) {
          return { method: "UNKNOWN", url: "/" };
        }
        const value = request as Record<string, unknown>;
        return {
          method: typeof value["method"] === "string" ? value["method"] : "UNKNOWN",
          url: safePath(typeof value["url"] === "string" ? value["url"] : "/"),
        };
      },
    },
  };
}

export function createServer(options: FastifyServerOptions = {}) {
  const app = Fastify({
    genReqId: () => randomUUID(),
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: "requestId",
    }),
    ...options,
  })
    .withTypeProvider<TypeBoxTypeProvider>()
    .setValidatorCompiler(TypeBoxValidatorCompiler);
  registerRequestLogContext(app);
  return app;
}

function registerRequestLogContext(app: FastifyInstance): void {
  const failedRequests = new WeakSet<FastifyRequest>();
  app.addHook("onRequest", (request, _reply, done) => {
    const traceId = parseTraceId(request.headers["traceparent"]);
    const correlation = routeCorrelation(request);
    request.log = request.log.child({
      requestId: request.id,
      ...(traceId === null ? {} : { traceId }),
      ...correlation,
    });
    request.log.info(
      {
        event: "request_started",
        method: request.method,
        route: request.routeOptions.url,
      },
      "Request started",
    );
    done();
  });
  app.addHook("onResponse", (request, reply, done) => {
    const failed = failedRequests.has(request);
    request.log[failed ? "error" : "info"](
      {
        event: failed ? "request_failed" : "request_completed",
        method: request.method,
        route: request.routeOptions.url,
        statusCode: reply.statusCode,
      },
      failed ? "Request failed" : "Request completed",
    );
    done();
  });
  app.addHook("onError", (request, _reply, _error, done) => {
    failedRequests.add(request);
    done();
  });
}

function routeCorrelation(request: FastifyRequest): Record<string, string> {
  if (typeof request.params !== "object" || request.params === null) {
    return {};
  }
  const params = request.params as Record<string, unknown>;
  return {
    ...(typeof params["interviewId"] === "string" ? { interviewId: params["interviewId"] } : {}),
    ...(typeof params["operationId"] === "string" ? { operationId: params["operationId"] } : {}),
  };
}

function parseTraceId(traceparent: string | string[] | undefined): string | null {
  const value = Array.isArray(traceparent) ? traceparent[0] : traceparent;
  if (value === undefined) {
    return null;
  }
  const match = TRACEPARENT_PATTERN.exec(value.toLowerCase());
  const version = match?.[1];
  const traceId = match?.[2];
  const parentId = match?.[3];
  if (
    version === undefined ||
    version === "ff" ||
    traceId === undefined ||
    /^0+$/u.test(traceId) ||
    parentId === undefined ||
    /^0+$/u.test(parentId)
  ) {
    return null;
  }
  return traceId;
}

function safePath(url: string): string {
  const queryIndex = url.indexOf("?");
  return queryIndex < 0 ? url : url.slice(0, queryIndex);
}
