import { type Static, Type } from "typebox";

import {
  IdempotencyKeySchema,
  InterviewIdSchema,
  InterviewQuestionCountSchema,
  InterviewVersionSchema,
  OperationIdSchema,
} from "./common.js";
import { type OperationStatusResponseDto, OperationStatusResponseSchema } from "./responses.js";

export const IdempotencyHeadersSchema = Type.Object({
  "idempotency-key": IdempotencyKeySchema,
});

export const InterviewCommandParamsSchema = Type.Object(
  {
    interviewId: InterviewIdSchema,
  },
  { additionalProperties: false },
);

export const CreateInterviewRequestSchema = Type.Object(
  {
    questionCount: InterviewQuestionCountSchema,
    expectedVersion: Type.Literal(0),
  },
  { additionalProperties: false },
);

export const SubmitAnswerRequestSchema = Type.Object(
  {
    expectedVersion: InterviewVersionSchema,
    text: Type.String({ minLength: 1, maxLength: 20_000, pattern: ".*\\S.*" }),
  },
  { additionalProperties: false },
);

export const SubmitSupplementRequestSchema = Type.Object(
  {
    expectedVersion: InterviewVersionSchema,
    text: Type.String({ minLength: 1, maxLength: 20_000, pattern: ".*\\S.*" }),
  },
  { additionalProperties: false },
);

export const RequestClarificationRequestSchema = Type.Object(
  {
    expectedVersion: InterviewVersionSchema,
  },
  { additionalProperties: false },
);

export const MarkQuestionUnknownRequestSchema = Type.Object(
  {
    expectedVersion: InterviewVersionSchema,
  },
  { additionalProperties: false },
);

export const SkipQuestionRequestSchema = Type.Object(
  {
    expectedVersion: InterviewVersionSchema,
  },
  { additionalProperties: false },
);

export const ContinueInterviewRequestSchema = Type.Object(
  {
    expectedVersion: InterviewVersionSchema,
  },
  { additionalProperties: false },
);

export const EndInterviewEarlyRequestSchema = Type.Object(
  {
    expectedVersion: InterviewVersionSchema,
  },
  { additionalProperties: false },
);

export const AbandonInterviewRequestSchema = Type.Object(
  {
    expectedVersion: InterviewVersionSchema,
  },
  { additionalProperties: false },
);

export const RetryOperationRequestSchema = Type.Object(
  {
    expectedVersion: InterviewVersionSchema,
    operationId: OperationIdSchema,
  },
  { additionalProperties: false },
);

export const OperationAcceptedResponseSchema = Type.Object(
  {
    operationId: OperationIdSchema,
  },
  { additionalProperties: false },
);

export const SupplementRequestSchema = SubmitSupplementRequestSchema;
export const UnknownQuestionRequestSchema = MarkQuestionUnknownRequestSchema;
export const ContinueRequestSchema = ContinueInterviewRequestSchema;
export const EarlyEndRequestSchema = EndInterviewEarlyRequestSchema;
export const AbandonRequestSchema = AbandonInterviewRequestSchema;
export const RetryRequestSchema = RetryOperationRequestSchema;
export const OperationResponseSchema = OperationStatusResponseSchema;

export type IdempotencyHeadersDto = Static<typeof IdempotencyHeadersSchema>;
export type InterviewCommandParamsDto = Static<typeof InterviewCommandParamsSchema>;
export type CreateInterviewRequestDto = Static<typeof CreateInterviewRequestSchema>;
export type SubmitAnswerRequestDto = Static<typeof SubmitAnswerRequestSchema>;
export type SubmitSupplementRequestDto = Static<typeof SubmitSupplementRequestSchema>;
export type RequestClarificationRequestDto = Static<typeof RequestClarificationRequestSchema>;
export type MarkQuestionUnknownRequestDto = Static<typeof MarkQuestionUnknownRequestSchema>;
export type SkipQuestionRequestDto = Static<typeof SkipQuestionRequestSchema>;
export type ContinueInterviewRequestDto = Static<typeof ContinueInterviewRequestSchema>;
export type EndInterviewEarlyRequestDto = Static<typeof EndInterviewEarlyRequestSchema>;
export type AbandonInterviewRequestDto = Static<typeof AbandonInterviewRequestSchema>;
export type RetryOperationRequestDto = Static<typeof RetryOperationRequestSchema>;
export type OperationAcceptedResponseDto = Static<typeof OperationAcceptedResponseSchema>;
export type OperationResponseDto = OperationStatusResponseDto;
