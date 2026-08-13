import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  createApiRouteErrorHandler,
  internalError,
  mapApiValidationError,
  notFoundError,
  unauthorizedError,
} from "../src/api-route-errors.js";

function replyHarness() {
  const send = vi.fn();
  const code = vi.fn(() => ({ send }));
  return {
    code,
    send,
    reply: { code } as unknown as FastifyReply,
  };
}

describe("API route errors", () => {
  it("builds the stable shared envelopes", () => {
    expect(unauthorizedError()).toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required",
      },
    });
    expect(notFoundError("operation")).toEqual({
      error: {
        code: "not_found",
        message: "Resource was not found.",
        resource: "operation",
      },
    });
    expect(internalError()).toEqual({
      error: {
        code: "internal_error",
        message: "An unexpected error occurred.",
      },
    });
  });

  it("preserves Fastify validation issue paths, codes, and messages", () => {
    const mapped = mapApiValidationError(
      {
        validationContext: "headers",
        validation: [
          {
            instancePath: "",
            keyword: "required",
            message: undefined,
          },
          {
            instancePath: "/interviewId",
            keyword: "pattern",
            message: "must match pattern",
          },
        ],
      } as unknown as FastifyError,
      false,
    );

    expect(mapped).toEqual({
      error: {
        code: "validation_error",
        message: "The request is invalid.",
        issues: [
          {
            path: "/headers",
            code: "required",
            message: "Request validation failed",
          },
          {
            path: "/interviewId",
            code: "pattern",
            message: "must match pattern",
          },
        ],
      },
    });
  });

  it("maps Fastify content parser errors to the stable body issue", () => {
    const error = {
      code: "FST_ERR_CTP_INVALID_JSON_BODY",
    } as FastifyError;

    expect(mapApiValidationError(error, true)).toEqual({
      error: {
        code: "validation_error",
        message: "The request is invalid.",
        issues: [
          {
            path: "/body",
            code: "FST_ERR_CTP_INVALID_JSON_BODY",
            message: "The request body is invalid.",
          },
        ],
      },
    });
    expect(mapApiValidationError(error, false)).toBeNull();
  });

  it("allows route-specific logging and unexpected envelopes", () => {
    const error = new Error("private detail") as FastifyError;
    const logError = vi.fn();
    const request = { log: { error: logError } } as unknown as FastifyRequest;
    const harness = replyHarness();
    const handler = createApiRouteErrorHandler({
      logEvent: "deletion_route_failed",
      logMessage: "Deletion route failed",
      mapContentTypeParserErrors: true,
      unexpectedError: () => ({
        error: {
          code: "deletion_failure",
          message: "Deletion request failed",
        },
      }),
    });

    handler(error, request, harness.reply);

    expect(logError).toHaveBeenCalledWith(
      { event: "deletion_route_failed" },
      "Deletion route failed",
    );
    expect(harness.code).toHaveBeenCalledWith(500);
    expect(harness.send).toHaveBeenCalledWith({
      error: {
        code: "deletion_failure",
        message: "Deletion request failed",
      },
    });
  });
});
