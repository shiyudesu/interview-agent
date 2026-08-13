import { RepositoryNotFoundError, type StoredOperation } from "@interview-agent/db";
import type { Interview, InterviewId, OperationId } from "@interview-agent/domain";

import { OperationRunnerError } from "./operation-errors.js";

export function requiredOperation(
  operation: StoredOperation | null,
  operationId: OperationId,
): StoredOperation {
  if (operation === null) {
    throw new RepositoryNotFoundError("Operation", operationId);
  }
  return operation;
}

export function requiredInterview(
  interview: Interview | null,
  interviewId: InterviewId,
): Interview {
  if (interview === null) {
    throw new RepositoryNotFoundError("interview", interviewId);
  }
  return interview;
}

export function requiredDate(value: Date | null, field: string): Date {
  if (value === null || !Number.isFinite(value.getTime())) {
    throw new OperationRunnerError(`Operation ${field} is unavailable`);
  }
  return value;
}

export function notBefore(value: Date, minimum: Date): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new OperationRunnerError("Operation completion time is invalid");
  }
  return value.getTime() < minimum.getTime() ? new Date(minimum.getTime()) : value;
}

export function isPostgresSerializationFailure(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return false;
    }
    const candidate = current as {
      readonly cause?: unknown;
      readonly code?: unknown;
    };
    if (candidate.code === "40001") {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}
