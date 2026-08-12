import {
  type InterviewId,
  InterviewVersionConflictError,
  InvalidInterviewCommandError,
} from "@interview-agent/domain";

import {
  type CanonicalInterviewStateDto,
  type ErrorEnvelopeDto,
  ErrorEnvelopeSchema,
} from "./errors.js";
import { InboundRequestValidationError, parseMappedDto } from "./mapping-validation.js";

export function mapDomainErrorToEnvelope(
  error: unknown,
  interviewId: InterviewId | null = null,
  currentState: CanonicalInterviewStateDto | null = null,
): ErrorEnvelopeDto {
  if (
    error instanceof InterviewVersionConflictError &&
    interviewId !== null &&
    currentState !== null
  ) {
    return parseMappedDto(
      ErrorEnvelopeSchema,
      {
        error: {
          code: "version_conflict",
          message: "Interview state changed; reload the canonical state and retry.",
          interviewId: String(interviewId),
          currentVersion: error.actualVersion,
          currentState,
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

  if (error instanceof InvalidInterviewCommandError) {
    return parseMappedDto(
      ErrorEnvelopeSchema,
      {
        error: {
          code: "command_rejected",
          message: "The interview does not accept this command in its current state.",
        },
      },
      "command rejection error",
    );
  }

  return {
    error: {
      code: "internal_error",
      message: "An unexpected error occurred.",
    },
  };
}
