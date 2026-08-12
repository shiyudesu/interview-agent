import type { OperationId } from "@interview-agent/domain";

import type { OperationFailureCodeDto } from "./errors.js";
import {
  ContractMappingError,
  parseMappedDto,
  serializeIsoTimestamp,
} from "./mapping-validation.js";
import { type OperationStatusResponseDto, OperationStatusResponseSchema } from "./responses.js";

export interface PersistedOperationProjection {
  readonly id: OperationId;
  readonly type: string;
  readonly status: "pending" | "processing" | "succeeded" | "failed";
  readonly retryable: boolean;
  readonly result:
    | (Readonly<Record<string, unknown>> & {
        readonly interviewId?: unknown;
        readonly interviewVersion?: unknown;
        readonly reportId?: unknown;
      })
    | null;
  readonly error:
    | (Readonly<Record<string, unknown>> & {
        readonly code?: unknown;
      })
    | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function mapOperationToStatusResponse(
  operation: PersistedOperationProjection,
): OperationStatusResponseDto {
  const base = {
    operationId: String(operation.id),
    createdAt: serializeIsoTimestamp(operation.createdAt, "operation.createdAt"),
    updatedAt: serializeIsoTimestamp(operation.updatedAt, "operation.updatedAt"),
  };
  if (operation.status === "pending" || operation.status === "processing") {
    return parseMappedDto(
      OperationStatusResponseSchema,
      { ...base, status: operation.status },
      "Operation status response",
    );
  }
  if (operation.status === "failed") {
    return parseMappedDto(
      OperationStatusResponseSchema,
      {
        ...base,
        status: "failed",
        failure: operationFailure(operation),
      },
      "Operation status response",
    );
  }
  const result = operation.result;
  if (result === null) {
    throw invalidOperation("Succeeded Operation has no result");
  }
  if (operation.type === "generate_report") {
    return parseMappedDto(
      OperationStatusResponseSchema,
      {
        ...base,
        status: "succeeded",
        result: {
          reportId: result.reportId,
        },
      },
      "Operation status response",
    );
  }
  return parseMappedDto(
    OperationStatusResponseSchema,
    {
      ...base,
      status: "succeeded",
      result: {
        interviewId: result.interviewId,
        interviewVersion: result.interviewVersion,
        reportId: result.reportId,
      },
    },
    "Operation status response",
  );
}

function operationFailure(operation: PersistedOperationProjection) {
  if (operation.error === null) {
    throw invalidOperation("Failed Operation has no error");
  }
  const code: OperationFailureCodeDto =
    operation.error.code === "model_failure" ? "model_failure" : "operation_failed";
  return {
    code,
    message: code === "model_failure" ? "Model processing failed." : "Operation processing failed.",
    retryable: operation.retryable,
  };
}

function invalidOperation(message: string): ContractMappingError {
  return new ContractMappingError("Operation status response", [
    {
      path: "/",
      code: "invalid_operation_projection",
      message,
    },
  ]);
}
