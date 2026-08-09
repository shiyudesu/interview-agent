import {
  type AbandonInterviewCommand,
  type AccountId,
  type AnswerMaterialId,
  type ContinueInterviewCommand,
  type CreateInterviewCommand,
  type EndInterviewEarlyCommand,
  type InterviewBlueprint,
  type InterviewId,
  type MarkQuestionUnknownCommand,
  type OperationId,
  parseAccountId,
  parseAnswerMaterialId,
  parseInterviewId,
  parseOperationId,
  type RequestQuestionClarificationCommand,
  type SkipQuestionCommand,
  type SubmitAnswerCommand,
  type SubmitSupplementCommand,
} from "@interview-agent/domain";

import {
  AbandonInterviewRequestSchema,
  ContinueInterviewRequestSchema,
  CreateInterviewRequestSchema,
  EndInterviewEarlyRequestSchema,
  MarkQuestionUnknownRequestSchema,
  RequestClarificationRequestSchema,
  RetryOperationRequestSchema,
  SkipQuestionRequestSchema,
  SubmitAnswerRequestSchema,
  SubmitSupplementRequestSchema,
} from "./commands.js";
import { checkInboundRequestDto, parseIsoTimestamp } from "./mapping-validation.js";

export interface TrustedInterviewCommandContext {
  readonly interviewId: string;
  readonly operationId: string;
  readonly occurredAt: string;
}

export interface TrustedCreateInterviewContext extends TrustedInterviewCommandContext {
  readonly accountId: string;
  readonly blueprint: InterviewBlueprint;
}

export interface TrustedAnswerCommandContext extends TrustedInterviewCommandContext {
  readonly answerMaterialId: string;
}

export interface RetryOperationInput {
  readonly interviewId: InterviewId;
  readonly operationId: OperationId;
  readonly failedOperationId: OperationId;
  readonly expectedVersion: number;
  readonly occurredAt: Date;
}

function commandBase(context: TrustedInterviewCommandContext, expectedVersion: number) {
  return {
    interviewId: parseInterviewId(context.interviewId),
    operationId: parseOperationId(context.operationId),
    expectedVersion,
    occurredAt: parseIsoTimestamp(context.occurredAt, "occurredAt"),
  };
}

export function mapCreateInterviewCommand(
  value: unknown,
  context: TrustedCreateInterviewContext,
): CreateInterviewCommand {
  const dto = checkInboundRequestDto(
    CreateInterviewRequestSchema,
    value,
    "create interview request",
  );
  return {
    type: "create_interview",
    ...commandBase(context, dto.expectedVersion),
    accountId: parseAccountId(context.accountId),
    questionCount: dto.questionCount,
    blueprint: context.blueprint,
  };
}

export function mapSubmitAnswerCommand(
  value: unknown,
  context: TrustedAnswerCommandContext,
): SubmitAnswerCommand {
  const dto = checkInboundRequestDto(SubmitAnswerRequestSchema, value, "submit answer request");
  return {
    type: "submit_answer",
    ...commandBase(context, dto.expectedVersion),
    answerMaterialId: parseAnswerMaterialId(context.answerMaterialId),
    text: dto.text,
  };
}

export function mapSubmitSupplementCommand(
  value: unknown,
  context: TrustedAnswerCommandContext,
): SubmitSupplementCommand {
  const dto = checkInboundRequestDto(
    SubmitSupplementRequestSchema,
    value,
    "submit supplement request",
  );
  return {
    type: "submit_supplement",
    ...commandBase(context, dto.expectedVersion),
    answerMaterialId: parseAnswerMaterialId(context.answerMaterialId),
    text: dto.text,
  };
}

export function mapRequestQuestionClarificationCommand(
  value: unknown,
  context: TrustedInterviewCommandContext,
): RequestQuestionClarificationCommand {
  const dto = checkInboundRequestDto(
    RequestClarificationRequestSchema,
    value,
    "clarification request",
  );
  return {
    type: "request_question_clarification",
    ...commandBase(context, dto.expectedVersion),
  };
}

export function mapMarkQuestionUnknownCommand(
  value: unknown,
  context: TrustedInterviewCommandContext,
): MarkQuestionUnknownCommand {
  const dto = checkInboundRequestDto(
    MarkQuestionUnknownRequestSchema,
    value,
    "unknown question request",
  );
  return {
    type: "mark_question_unknown",
    ...commandBase(context, dto.expectedVersion),
  };
}

export function mapSkipQuestionCommand(
  value: unknown,
  context: TrustedInterviewCommandContext,
): SkipQuestionCommand {
  const dto = checkInboundRequestDto(SkipQuestionRequestSchema, value, "skip question request");
  return {
    type: "skip_question",
    ...commandBase(context, dto.expectedVersion),
  };
}

export function mapContinueInterviewCommand(
  value: unknown,
  context: TrustedInterviewCommandContext,
): ContinueInterviewCommand {
  const dto = checkInboundRequestDto(
    ContinueInterviewRequestSchema,
    value,
    "continue interview request",
  );
  return {
    type: "continue_interview",
    ...commandBase(context, dto.expectedVersion),
  };
}

export function mapEndInterviewEarlyCommand(
  value: unknown,
  context: TrustedInterviewCommandContext,
): EndInterviewEarlyCommand {
  const dto = checkInboundRequestDto(EndInterviewEarlyRequestSchema, value, "early end request");
  return {
    type: "end_interview_early",
    ...commandBase(context, dto.expectedVersion),
  };
}

export function mapAbandonInterviewCommand(
  value: unknown,
  context: TrustedInterviewCommandContext,
): AbandonInterviewCommand {
  const dto = checkInboundRequestDto(
    AbandonInterviewRequestSchema,
    value,
    "abandon interview request",
  );
  return {
    type: "abandon_interview",
    ...commandBase(context, dto.expectedVersion),
  };
}

export function mapRetryOperationInput(
  value: unknown,
  context: TrustedInterviewCommandContext,
): RetryOperationInput {
  const dto = checkInboundRequestDto(RetryOperationRequestSchema, value, "retry operation request");
  return {
    ...commandBase(context, dto.expectedVersion),
    failedOperationId: parseOperationId(dto.operationId),
  };
}

export function serializeAccountId(value: AccountId): string {
  return String(value);
}

export function serializeAnswerMaterialId(value: AnswerMaterialId): string {
  return String(value);
}

export function serializeInterviewId(value: InterviewId): string {
  return String(value);
}

export function serializeOperationId(value: OperationId): string {
  return String(value);
}
