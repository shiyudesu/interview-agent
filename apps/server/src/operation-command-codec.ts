import {
  type JsonObject,
  RepositoryIdempotencyConflictError,
  RepositoryOperationRetryConflictError,
  type StoredOperation,
} from "@interview-agent/db";
import {
  type AbandonInterviewCommand,
  type ContinueInterviewCommand,
  type EndInterviewEarlyCommand,
  type Interview,
  type InterviewOperationPlan,
  type MarkQuestionUnknownCommand,
  type OperationId,
  parseEvaluationId,
  parseMessageId,
  parseOperationId,
  type RequestQuestionClarificationCommand,
  type SkipQuestionCommand,
  type SubmitAnswerCommand,
  type SubmitSupplementCommand,
} from "@interview-agent/domain";

import { OperationRunnerError } from "./operation-errors.js";
import { answerMaterialId, derivedIdentifier } from "./operation-identity.js";
import type {
  CreateInterviewOperationInput,
  ModelCompletion,
  ProgressCommandRequest,
} from "./operation-types.js";

export function decodeInitialCommand(
  operation: StoredOperation,
):
  | SubmitAnswerCommand
  | SubmitSupplementCommand
  | RequestQuestionClarificationCommand
  | MarkQuestionUnknownCommand
  | SkipQuestionCommand
  | ContinueInterviewCommand
  | AbandonInterviewCommand
  | EndInterviewEarlyCommand {
  const base = commandBase(operation);
  switch (operation.type) {
    case "submit_answer":
      return {
        ...base,
        type: operation.type,
        answerMaterialId: answerMaterialId(operation.id),
        text: readText(operation.input, operation.id),
      };
    case "submit_supplement":
      return {
        ...base,
        type: operation.type,
        answerMaterialId: answerMaterialId(operation.id),
        text: readText(operation.input, operation.id),
      };
    case "request_question_clarification":
    case "mark_question_unknown":
    case "skip_question":
    case "continue_interview":
    case "end_interview_early":
    case "abandon_interview":
      return { ...base, type: operation.type };
    default:
      throw new OperationRunnerError(`Operation ${operation.id} is not an interview command`);
  }
}

export function decodePlannedCommand(
  operation: StoredOperation,
): SubmitAnswerCommand | SubmitSupplementCommand | RequestQuestionClarificationCommand {
  const command = decodeInitialCommand(operation);
  if (
    command.type !== "submit_answer" &&
    command.type !== "submit_supplement" &&
    command.type !== "request_question_clarification"
  ) {
    throw new RepositoryOperationRetryConflictError(operation.id);
  }
  return command;
}

export function reconstructPlan(
  interview: Interview,
  operation: StoredOperation,
): InterviewOperationPlan {
  const pending = interview.pendingOperation;
  if (pending === null || pending.operationId !== operation.id) {
    throw new OperationRunnerError(`Interview ${interview.id} has no matching pending Operation`);
  }
  const command = decodePlannedCommand(operation);
  if (pending.operation === "question_clarification") {
    if (command.type !== "request_question_clarification") {
      throw new OperationRunnerError("Pending clarification Operation has the wrong command type");
    }
    return {
      kind: "operation_plan",
      operation: "question_clarification",
      interviewId: interview.id,
      operationId: operation.id,
      questionPosition: pending.questionPosition,
      acceptedAt: pending.acceptedAt,
      interview,
      command,
    };
  }
  if (command.type === "request_question_clarification") {
    throw new OperationRunnerError("Pending answer Operation has the wrong command type");
  }
  return {
    kind: "operation_plan",
    operation: "answer_analysis",
    interviewId: interview.id,
    operationId: operation.id,
    questionPosition: pending.questionPosition,
    acceptedAt: pending.acceptedAt,
    interview,
    command,
    material: {
      id: answerMaterialId(operation.id),
      kind:
        command.type === "submit_supplement"
          ? "supplement"
          : hasUnansweredFollowUp(interview, pending.questionPosition)
            ? "follow_up_answer"
            : "main_answer",
      text: command.text,
      submittedAt: operation.createdAt,
    },
  };
}

export function completionCommand(
  operation: StoredOperation,
  interview: Interview,
  completion: ModelCompletion,
  occurredAt: Date,
) {
  const base = {
    interviewId: interview.id,
    operationId: operation.id,
    expectedVersion: interview.version,
    occurredAt,
  };
  if (completion.kind === "clarification") {
    return {
      ...base,
      type: "record_question_clarification" as const,
      messageId: parseMessageId(derivedIdentifier("message", operation.id)),
      text: completion.text,
    };
  }
  if (completion.kind === "follow_up") {
    const recommendation = completion.evaluation.recommendedFollowUpGoal;
    if (recommendation === null) {
      throw new OperationRunnerError("Follow-up completion is missing its selected goal");
    }
    return {
      ...base,
      type: "record_system_follow_up" as const,
      messageId: parseMessageId(derivedIdentifier("message", operation.id)),
      goalId: recommendation.goalId,
      kind: recommendation.kind,
      purpose: recommendation.purpose,
      responseClassification: completion.evaluation.classification,
      text: completion.text,
    };
  }
  return {
    ...base,
    type: "record_question_evaluation" as const,
    evaluation: {
      id: parseEvaluationId(derivedIdentifier("evaluation", operation.id)),
      classification: completion.evaluation.classification,
      rubricItems: completion.evaluation.rubricItems,
    },
  };
}

export function progressOperationInput(
  request: ProgressCommandRequest,
  questionPosition: number,
): JsonObject {
  return {
    questionPosition,
    ...(request.text === undefined ? {} : { text: request.text }),
  };
}

export function creationOperationInput(interview: Interview): JsonObject {
  return {
    questionCount: interview.questionCount,
    selectionSeed: interview.blueprint.selectionSeed,
    questions: interview.blueprint.questions.map(({ position, question }) => ({
      position,
      questionId: String(question.questionId),
      questionVersion: question.questionVersion,
    })),
  };
}

export function assertExistingCreationMatches(
  existing: StoredOperation,
  input: CreateInterviewOperationInput,
): void {
  if (
    existing.type !== "create_interview" ||
    existing.expectedVersion !== input.expectedVersion ||
    existing.input["questionCount"] !== input.questionCount
  ) {
    throw new RepositoryIdempotencyConflictError(
      existing.idempotencyScope,
      existing.idempotencyKey,
    );
  }
}

export function operationResult(
  interview: Interview,
  reportOperationId: OperationId | null = null,
): JsonObject {
  return {
    interviewId: String(interview.id),
    interviewVersion: interview.version,
    reportId: interview.reportId === null ? null : String(interview.reportId),
    ...(reportOperationId === null ? {} : { reportOperationId: String(reportOperationId) }),
  };
}

export function creationOperationResult(operation: StoredOperation): JsonObject {
  if (operation.type !== "create_interview" || operation.input["questionCount"] === undefined) {
    throw new OperationRunnerError(`Operation ${operation.id} has invalid creation input`);
  }
  return {
    interviewId: String(operation.interviewId),
    interviewVersion: 1,
    reportId: null,
  };
}

export function retryOperationResult(target: StoredOperation, interview: Interview): JsonObject {
  return {
    ...operationResult(interview),
    targetOperationId: String(target.id),
    targetOperationStatus: target.status,
  };
}

export function linkedReportOperationId(operation: StoredOperation): OperationId | null {
  const value = operation.result?.["reportOperationId"];
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new OperationRunnerError(`Operation ${operation.id} has an invalid report link`);
  }
  return parseOperationId(value);
}

export function readQuestionPosition(input: JsonObject, operationId: OperationId): number {
  const value = input["questionPosition"];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new OperationRunnerError(`Operation ${operationId} has an invalid question position`);
  }
  return value;
}

function commandBase(operation: StoredOperation) {
  readQuestionPosition(operation.input, operation.id);
  return {
    interviewId: operation.interviewId,
    operationId: operation.id,
    expectedVersion: operation.expectedVersion,
    occurredAt: operation.createdAt,
  };
}

function readText(input: JsonObject, operationId: OperationId): string {
  const value = input["text"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OperationRunnerError(`Operation ${operationId} has invalid answer text`);
  }
  return value;
}

function requiredQuestionState(interview: Interview, position: number) {
  const question = interview.questions[position - 1];
  if (question === undefined || question.position !== position) {
    throw new OperationRunnerError(`Interview ${interview.id} question state is invalid`);
  }
  return question;
}

function hasUnansweredFollowUp(interview: Interview, position: number): boolean {
  const question = requiredQuestionState(interview, position);
  return (
    question.systemFollowUps.length >
    question.answerMaterial.filter((material) => material.kind === "follow_up_answer").length
  );
}
