import { type InterviewId, InterviewVersionConflictError } from "@interview-agent/domain";

import { type ErrorEnvelopeDto, ErrorEnvelopeSchema } from "./errors.js";
import { InboundRequestValidationError, parseMappedDto } from "./mapping-validation.js";

export function mapDomainErrorToEnvelope(
  error: unknown,
  interviewId: InterviewId | null = null,
): ErrorEnvelopeDto {
  if (error instanceof InterviewVersionConflictError && interviewId !== null) {
    return parseMappedDto(
      ErrorEnvelopeSchema,
      {
        error: {
          code: "version_conflict",
          message: "Interview state changed; reload the canonical state and retry.",
          interviewId: String(interviewId),
          currentVersion: error.actualVersion,
        },
      },
      "version conflict error",
    );
  }

  if (error instanceof InboundRequestValidationError) {
    return parseMappedDto(
      ErrorEnvelopeSchema,
      {
        error: {
          code: "validation_error",
          message: "The request is invalid.",
          issues: error.issues.map((issue) => ({
            path: issue.path,
            code: issue.code,
            message: issue.message,
          })),
        },
      },
      "validation error",
    );
  }

  return {
    error: {
      code: "internal_error",
      message: "An unexpected error occurred.",
    },
  };
}
