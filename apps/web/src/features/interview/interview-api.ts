import {
  type CurrentInterviewResponseDto,
  isCurrentInterviewResponseDto,
  isOperationStatusResponseDto,
  type OperationStatusResponseDto,
} from "@interview-agent/contracts/responses";

import { ApiClientError, apiClient } from "../../lib/api-client.js";

export async function getActiveInterview(
  signal?: AbortSignal,
): Promise<CurrentInterviewResponseDto | null> {
  try {
    return await apiClient.request("/api/v1/interviews/active", {
      decode(value) {
        if (!isCurrentInterviewResponseDto(value)) {
          throw new TypeError("Invalid active interview response");
        }
        return value;
      },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (
      error instanceof ApiClientError &&
      error.status === 404 &&
      error.apiError?.code === "not_found" &&
      error.apiError.resource === "interview"
    ) {
      return null;
    }
    throw error;
  }
}

export function createInterview(
  questionCount: 5 | 10 | 15,
  idempotencyKey: string,
): Promise<OperationStatusResponseDto> {
  return interviewCommand(
    "/api/v1/interviews",
    {
      expectedVersion: 0,
      questionCount,
    },
    idempotencyKey,
  );
}

export function abandonInterview(
  interviewId: string,
  expectedVersion: number,
  idempotencyKey: string,
): Promise<OperationStatusResponseDto> {
  return interviewCommand(
    `/api/v1/interviews/${interviewId}/abandon`,
    {
      expectedVersion,
    },
    idempotencyKey,
  );
}

function interviewCommand(
  path: `/api/${string}`,
  json: unknown,
  idempotencyKey: string,
): Promise<OperationStatusResponseDto> {
  return apiClient.request(path, {
    decode(value) {
      if (!isOperationStatusResponseDto(value)) {
        throw new TypeError("Invalid Operation response");
      }
      return value;
    },
    headers: {
      "idempotency-key": idempotencyKey,
    },
    json,
    method: "POST",
  });
}
