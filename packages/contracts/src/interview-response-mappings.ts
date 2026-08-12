import {
  getCurrentQuestion,
  getInterviewExpiresAt,
  getInterviewProgress,
  type Interview,
  type MessageId,
  type OperationId,
} from "@interview-agent/domain";

import type { OperationFailureCodeDto } from "./errors.js";
import {
  ContractMappingError,
  parseMappedDto,
  serializeIsoTimestamp,
} from "./mapping-validation.js";
import { type InterviewDetailResponseDto, InterviewDetailResponseSchema } from "./responses.js";

export interface InterviewMessageProjection {
  readonly id: MessageId;
  readonly questionPosition: number;
  readonly role: "user" | "interviewer";
  readonly kind:
    | "main_question"
    | "answer"
    | "supplement"
    | "clarification"
    | "follow_up"
    | "transition";
  readonly text: string;
  readonly createdAt: Date;
}

export type PublicOperationProjection =
  | {
      readonly operationId: OperationId;
      readonly status: "pending" | "processing";
    }
  | {
      readonly operationId: OperationId;
      readonly status: "failed";
      readonly failure: {
        readonly code: OperationFailureCodeDto;
        readonly message: string;
        readonly retryable: boolean;
      };
    };

export interface InterviewResponseContext {
  readonly messages: readonly InterviewMessageProjection[];
  readonly operation: PublicOperationProjection | null;
  readonly endedAt: Date | null;
}

function invalidInterviewState(message: string): never {
  throw new ContractMappingError("interview response", [
    {
      path: "/",
      code: "invalid_interview_state",
      message,
    },
  ]);
}

function mapMessages(messages: readonly InterviewMessageProjection[]) {
  return messages.map((message) => ({
    id: String(message.id),
    role: message.role,
    kind: message.kind,
    text: message.text,
    createdAt: serializeIsoTimestamp(message.createdAt, "message.createdAt"),
  }));
}

function assertMessageVisibility(
  interview: Interview,
  messages: readonly InterviewMessageProjection[],
): void {
  const mainQuestionPositions = new Set<number>();
  for (const message of messages) {
    if (
      !Number.isInteger(message.questionPosition) ||
      message.questionPosition < 1 ||
      message.questionPosition > interview.currentQuestionPosition
    ) {
      invalidInterviewState("Messages cannot reveal a future question");
    }
    const blueprintItem = interview.blueprint.questions[message.questionPosition - 1];
    if (blueprintItem === undefined || blueprintItem.position !== message.questionPosition) {
      invalidInterviewState("Messages must reference a visible question snapshot");
    }
    if (message.kind !== "main_question") {
      continue;
    }
    if (mainQuestionPositions.has(message.questionPosition)) {
      invalidInterviewState("Each visible question requires exactly one main message");
    }
    if (message.text !== blueprintItem.question.displayedWording) {
      invalidInterviewState("Main question messages must match the visible snapshot");
    }
    mainQuestionPositions.add(message.questionPosition);
  }
  for (let position = 1; position <= interview.currentQuestionPosition; position += 1) {
    if (!mainQuestionPositions.has(position)) {
      invalidInterviewState("Every visible question requires one main message");
    }
  }
}

function assertChronology(
  interview: Interview,
  messages: readonly InterviewMessageProjection[],
  endedAt: Date | null = null,
) {
  assertMessageVisibility(interview, messages);
  const createdAtMs = interview.createdAt.getTime();
  const activityAtMs = interview.lastEffectiveActivityAt.getTime();
  const expiresAtMs = getInterviewExpiresAt(interview).getTime();
  if (
    !Number.isFinite(createdAtMs) ||
    !Number.isFinite(activityAtMs) ||
    !Number.isFinite(expiresAtMs)
  ) {
    return invalidInterviewState("Interview timestamps must be valid");
  }
  if (activityAtMs < createdAtMs) {
    return invalidInterviewState("Last effective activity cannot precede interview creation");
  }
  if (expiresAtMs < activityAtMs) {
    return invalidInterviewState("Interview expiry cannot precede last effective activity");
  }

  const endedAtMs = endedAt?.getTime() ?? null;
  if (endedAtMs !== null) {
    if (!Number.isFinite(endedAtMs)) {
      return invalidInterviewState("Interview end timestamp must be valid");
    }
    if (endedAtMs < createdAtMs || endedAtMs < activityAtMs) {
      return invalidInterviewState(
        "Interview end timestamp cannot precede creation or last effective activity",
      );
    }
  }

  let previousMessageAtMs = createdAtMs;
  for (const message of messages) {
    const messageAtMs = message.createdAt.getTime();
    if (!Number.isFinite(messageAtMs)) {
      return invalidInterviewState("Message timestamps must be valid");
    }
    if (messageAtMs < createdAtMs) {
      return invalidInterviewState("Message timestamps cannot precede interview creation");
    }
    if (messageAtMs > expiresAtMs) {
      return invalidInterviewState("Message timestamps cannot follow interview expiry");
    }
    if (message.role === "user" && messageAtMs > activityAtMs) {
      return invalidInterviewState("User activity messages cannot follow last effective activity");
    }
    if (messageAtMs < previousMessageAtMs) {
      return invalidInterviewState("Messages must be ordered chronologically");
    }
    if (endedAtMs !== null && messageAtMs > endedAtMs) {
      return invalidInterviewState("Message timestamps cannot follow interview completion");
    }
    previousMessageAtMs = messageAtMs;
  }
}

function mapOperation(operation: PublicOperationProjection) {
  if (operation.status !== "failed") {
    return {
      operationId: String(operation.operationId),
      status: operation.status,
    };
  }
  return {
    operationId: String(operation.operationId),
    status: "failed",
    failure: {
      code: operation.failure.code,
      message: operation.failure.message,
      retryable: operation.failure.retryable,
    },
  };
}

function activeBase(interview: Interview, context: InterviewResponseContext) {
  assertChronology(interview, context.messages);
  return {
    id: String(interview.id),
    status: "active",
    version: interview.version,
    progress: getInterviewProgress(interview),
    currentWording: getCurrentQuestion(interview).displayedWording,
    messages: mapMessages(context.messages),
    startedAt: serializeIsoTimestamp(interview.createdAt, "startedAt"),
    lastEffectiveActivityAt: serializeIsoTimestamp(
      interview.lastEffectiveActivityAt,
      "lastEffectiveActivityAt",
    ),
    expiresAt: serializeIsoTimestamp(getInterviewExpiresAt(interview), "expiresAt"),
  };
}

function awaitingResponseActions(interview: Interview): string[] {
  return [
    "submit_answer",
    "request_clarification",
    "mark_unknown",
    "skip",
    ...(interview.questions.some((question) => question.outcome !== null) ? ["end_early"] : []),
    "abandon",
  ];
}

function mapActiveInterview(interview: Interview, context: InterviewResponseContext) {
  if (interview.phase === null) {
    return invalidInterviewState("Active interviews require a phase");
  }
  const base = activeBase(interview, context);

  if (interview.phase === "processing") {
    const pending = interview.pendingOperation;
    if (pending === null) {
      return invalidInterviewState("Processing interviews require a pending Operation");
    }
    if (
      context.operation === null ||
      context.operation.status !== "processing" ||
      context.operation.operationId !== pending.operationId
    ) {
      return invalidInterviewState("Processing Operation does not match the domain state");
    }
    return {
      ...base,
      phase: "processing",
      operation: mapOperation(context.operation),
      availableActions: [],
    };
  }

  if (interview.phase === "awaiting_response") {
    if (context.operation !== null && context.operation.status !== "failed") {
      return {
        ...base,
        phase: "awaiting_response",
        operation: mapOperation(context.operation),
        availableActions: [],
      };
    }
    const availableActions = awaitingResponseActions(interview);
    if (context.operation === null) {
      return {
        ...base,
        phase: "awaiting_response",
        availableActions,
      };
    }
    return {
      ...base,
      phase: "awaiting_response",
      operation: mapOperation(context.operation),
      availableActions: [
        ...availableActions,
        ...(context.operation.failure.retryable ? ["retry"] : []),
      ],
    };
  }

  if (context.operation !== null && context.operation.status !== "failed") {
    return invalidInterviewState("Only failed Operations may remain on an actionable phase");
  }

  const availableActions = ["submit_supplement", "continue", "end_early", "abandon"];
  if (context.operation === null) {
    return {
      ...base,
      phase: "awaiting_continue",
      availableActions,
    };
  }
  return {
    ...base,
    phase: "awaiting_continue",
    operation: mapOperation(context.operation),
    availableActions: [
      ...availableActions,
      ...(context.operation.failure.retryable ? ["retry"] : []),
    ],
  };
}

function mapReportPendingInterview(interview: Interview, context: InterviewResponseContext) {
  if (interview.pendingReportKind === null) {
    return invalidInterviewState("Report-pending interviews require a report kind");
  }
  if (
    context.operation !== null &&
    context.operation.status === "failed" &&
    !context.operation.failure.retryable
  ) {
    return invalidInterviewState("Report-pending failures must remain retryable");
  }
  assertChronology(interview, context.messages);
  const base = {
    id: String(interview.id),
    status: "report_pending",
    reportKind: interview.pendingReportKind,
    version: interview.version,
    progress: getInterviewProgress(interview),
    messages: mapMessages(context.messages),
    startedAt: serializeIsoTimestamp(interview.createdAt, "startedAt"),
    lastEffectiveActivityAt: serializeIsoTimestamp(
      interview.lastEffectiveActivityAt,
      "lastEffectiveActivityAt",
    ),
    expiresAt: serializeIsoTimestamp(getInterviewExpiresAt(interview), "expiresAt"),
  };
  if (context.operation === null) {
    return {
      ...base,
      availableActions: [],
    };
  }
  return {
    ...base,
    operation: mapOperation(context.operation),
    availableActions: context.operation.status === "failed" ? ["retry"] : [],
  };
}

function requireEndedAt(context: InterviewResponseContext): Date {
  if (context.endedAt === null) {
    return invalidInterviewState("Terminal interviews require an end timestamp");
  }
  return context.endedAt;
}

function mapTerminalInterview(interview: Interview, context: InterviewResponseContext) {
  if (interview.status === "deleting") {
    return {
      id: String(interview.id),
      status: "deleting",
      version: interview.version,
    };
  }

  const endedAt = requireEndedAt(context);
  assertChronology(interview, context.messages, endedAt);
  const terminalBase = {
    id: String(interview.id),
    version: interview.version,
    questionCount: interview.questionCount,
    startedAt: serializeIsoTimestamp(interview.createdAt, "startedAt"),
    endedAt: serializeIsoTimestamp(endedAt, "endedAt"),
    messages: mapMessages(context.messages),
  };

  if (interview.status === "abandoned") {
    return {
      ...terminalBase,
      status: "abandoned",
    };
  }
  if (interview.reportId === null) {
    return invalidInterviewState("Completed and early-ended interviews require a report ID");
  }
  return {
    ...terminalBase,
    status: interview.status,
    reportId: String(interview.reportId),
  };
}

export function mapInterviewToResponse(
  interview: Interview,
  context: InterviewResponseContext,
): InterviewDetailResponseDto {
  const mapped =
    interview.status === "active"
      ? mapActiveInterview(interview, context)
      : interview.status === "report_pending"
        ? mapReportPendingInterview(interview, context)
        : mapTerminalInterview(interview, context);
  return parseMappedDto(InterviewDetailResponseSchema, mapped, "interview response");
}
