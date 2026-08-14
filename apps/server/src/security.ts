import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { crossOriginRequestError, RateLimitExceededError } from "./api-route-errors.js";
import { trustedApplicationOrigins } from "./application-origins.js";
import type { ServerConfig } from "./config.js";

const RATE_LIMIT_WINDOW_MS = 60_000;
export const MAX_REQUEST_BODY_BYTES = 96 * 1_024;

export const API_BODY_LIMITS = {
  authentication: 16 * 1_024,
  controlCommand: 4 * 1_024,
  textCommand: MAX_REQUEST_BODY_BYTES,
  deletion: 1 * 1_024,
} as const;

export const API_RATE_LIMITS = {
  read: {
    max: 120,
    timeWindow: RATE_LIMIT_WINDOW_MS,
    groupId: "api-read",
  },
  command: {
    max: 30,
    timeWindow: RATE_LIMIT_WINDOW_MS,
    groupId: "api-command",
  },
  stream: {
    max: 20,
    timeWindow: RATE_LIMIT_WINDOW_MS,
    groupId: "api-stream",
  },
  deletion: {
    max: 5,
    timeWindow: RATE_LIMIT_WINDOW_MS,
    groupId: "api-deletion",
  },
} as const;

export async function registerSecurityControls(
  app: FastifyInstance,
  config: Pick<ServerConfig, "auth" | "environment">,
): Promise<void> {
  await app.register(helmet, {
    global: true,
    ...(config.environment === "production" ? {} : { contentSecurityPolicy: false }),
    hsts:
      config.environment === "production"
        ? {
            maxAge: 31_536_000,
            includeSubDomains: true,
            preload: true,
          }
        : false,
  });
  await app.register(rateLimit, {
    global: false,
    hook: "onRequest",
    keyGenerator: (request) => request.ip,
    skipOnError: false,
    errorResponseBuilder: (_request, context) =>
      new RateLimitExceededError(Math.max(1, Math.ceil(context.ttl / 1_000))),
  });

  const trustedOrigins = new Set(trustedApplicationOrigins(config));
  app.addHook("onRequest", (request, reply, done) => {
    if (isRejectedCrossOriginApiRequest(request, trustedOrigins)) {
      reply.code(403).send(crossOriginRequestError());
      return;
    }
    done();
  });
}

function isRejectedCrossOriginApiRequest(
  request: FastifyRequest,
  trustedOrigins: ReadonlySet<string>,
): boolean {
  if (!isUnsafeMethod(request.method) || !isProtectedApiRoute(request.routeOptions.url)) {
    return false;
  }

  const origin = singleHeader(request.headers.origin);
  if (origin === null) {
    return true;
  }
  if (origin !== undefined && !trustedOrigins.has(origin)) {
    return true;
  }
  return singleHeader(request.headers["sec-fetch-site"]) === "cross-site";
}

function isUnsafeMethod(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function isProtectedApiRoute(route: string | undefined): boolean {
  return route !== undefined && (route === "/api/v1" || route.startsWith("/api/v1/"));
}

function singleHeader(value: string | string[] | undefined): string | null | undefined {
  return Array.isArray(value) ? null : value;
}
