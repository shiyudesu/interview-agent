import type { ErrorEnvelopeDto } from "@interview-agent/contracts";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

export type ApiErrorResource = "account" | "interview" | "operation" | "report";

export class RateLimitExceededError extends Error {
  readonly statusCode = 429;
  readonly code = "RATE_LIMIT_EXCEEDED";

  constructor(readonly retryAfterSeconds: number) {
    super("Rate limit exceeded");
    this.name = "RateLimitExceededError";
  }
}

export function unauthorizedError(): ErrorEnvelopeDto {
  return {
    error: {
      code: "unauthorized",
      message: "Authentication is required",
    },
  };
}

export function crossOriginRequestError(): ErrorEnvelopeDto {
  return {
    error: {
      code: "cross_origin_request",
      message: "Cross-origin requests are not allowed.",
    },
  };
}

export function payloadTooLargeError(): ErrorEnvelopeDto {
  return {
    error: {
      code: "payload_too_large",
      message: "The request body is too large.",
    },
  };
}

export function rateLimitError(retryAfterSeconds: number): ErrorEnvelopeDto {
  return {
    error: {
      code: "rate_limit_exceeded",
      message: "Too many requests; retry later.",
      retryAfterSeconds,
    },
  };
}

export function notFoundError(resource: ApiErrorResource): ErrorEnvelopeDto {
  return {
    error: {
      code: "not_found",
      message: "Resource was not found.",
      resource,
    },
  };
}

export function internalError(): ErrorEnvelopeDto {
  return {
    error: {
      code: "internal_error",
      message: "An unexpected error occurred.",
    },
  };
}

export function mapApiValidationError(
  error: FastifyError,
  mapContentTypeParserErrors: boolean,
): ErrorEnvelopeDto | null {
  if (error.validation !== undefined) {
    return {
      error: {
        code: "validation_error",
        message: "The request is invalid.",
        issues: error.validation.map((issue) => ({
          path: issue.instancePath || `/${error.validationContext ?? "request"}`,
          code: issue.keyword,
          message: issue.message ?? "Request validation failed",
        })),
      },
    };
  }
  if (
    mapContentTypeParserErrors &&
    typeof error.code === "string" &&
    error.code.startsWith("FST_ERR_CTP_")
  ) {
    return {
      error: {
        code: "validation_error",
        message: "The request is invalid.",
        issues: [
          {
            path: "/body",
            code: error.code,
            message: "The request body is invalid.",
          },
        ],
      },
    };
  }
  return null;
}

export interface ApiRouteErrorHandlerOptions {
  readonly logEvent: string;
  readonly logMessage: string;
  readonly mapContentTypeParserErrors: boolean;
  readonly unexpectedError?: () => unknown;
}

export function createApiRouteErrorHandler(options: ApiRouteErrorHandlerOptions) {
  return (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof RateLimitExceededError) {
      return reply.code(429).send(rateLimitError(error.retryAfterSeconds));
    }
    if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.code(413).send(payloadTooLargeError());
    }
    const validationError = mapApiValidationError(error, options.mapContentTypeParserErrors);
    if (validationError !== null) {
      return reply.code(400).send(validationError);
    }
    request.log.error({ event: options.logEvent }, options.logMessage);
    return reply.code(500).send(options.unexpectedError?.() ?? internalError());
  };
}
