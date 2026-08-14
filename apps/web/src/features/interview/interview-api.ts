import {
  type ActiveInterviewActionDto,
  type CurrentInterviewResponseDto,
  type InterviewDetailResponseDto,
  type InterviewHistoryResponseDto,
  isCurrentInterviewResponseDto,
  isInterviewDetailResponseDto,
  isInterviewHistoryResponseDto,
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

export function getInterviewDetail(
  interviewId: string,
  signal?: AbortSignal,
): Promise<InterviewDetailResponseDto> {
  return apiClient.request(`/api/v1/interviews/${interviewId}`, {
    decode(value) {
      if (!isInterviewDetailResponseDto(value)) {
        throw new TypeError("Invalid interview detail response");
      }
      return value;
    },
    ...(signal === undefined ? {} : { signal }),
  });
}

export function getInterviewHistory(
  cursor: string | null,
  signal?: AbortSignal,
): Promise<InterviewHistoryResponseDto> {
  const query = new URLSearchParams({ limit: "20" });
  if (cursor !== null) {
    query.set("cursor", cursor);
  }
  return apiClient.request(`/api/v1/interviews?${query.toString()}`, {
    decode(value) {
      if (!isInterviewHistoryResponseDto(value)) {
        throw new TypeError("Invalid interview history response");
      }
      return value;
    },
    ...(signal === undefined ? {} : { signal }),
  });
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

export interface InterviewActionCommand {
  readonly action: ActiveInterviewActionDto;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly interviewId: string;
  readonly operationId?: string;
  readonly text?: string;
}

export function runInterviewAction(
  command: InterviewActionCommand,
): Promise<OperationStatusResponseDto> {
  const endpoint = actionEndpoint(command.action);
  return interviewCommand(
    `/api/v1/interviews/${command.interviewId}/${endpoint}`,
    commandBody(command),
    command.idempotencyKey,
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

function actionEndpoint(action: ActiveInterviewActionDto): string {
  switch (action) {
    case "submit_answer":
      return "answers";
    case "submit_supplement":
      return "supplements";
    case "request_clarification":
      return "clarifications";
    case "mark_unknown":
      return "unknown";
    case "skip":
      return "skip";
    case "continue":
      return "continue";
    case "end_early":
      return "end-early";
    case "abandon":
      return "abandon";
    case "retry":
      return "retry";
  }
}

function commandBody(command: InterviewActionCommand): Record<string, unknown> {
  const base = { expectedVersion: command.expectedVersion };
  if (command.action === "submit_answer" || command.action === "submit_supplement") {
    return { ...base, text: command.text ?? "" };
  }
  if (command.action === "retry") {
    return { ...base, operationId: command.operationId ?? "" };
  }
  return base;
}
