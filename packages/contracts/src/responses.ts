import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

import {
  AccountIdSchema,
  InterviewIdSchema,
  InterviewQuestionCountSchema,
  InterviewVersionSchema,
  IsoTimestampSchema,
  MessageIdSchema,
  OperationIdSchema,
  PageInfoSchema,
  ReportIdSchema,
  ScoreSchema,
} from "./common.js";
import { OperationFailureCodeSchema, OperationFailureDetailSchema } from "./errors.js";

export const LinkedIdentitySchema = Type.Object(
  {
    provider: Type.Union([Type.Literal("email_otp"), Type.Literal("github")]),
    providerAccountId: Type.String({ minLength: 1 }),
    linkedAt: IsoTimestampSchema,
  },
  { additionalProperties: false },
);

export const AccountSessionSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    expiresAt: IsoTimestampSchema,
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
    ipAddress: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    userAgent: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    current: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const AccountResponseSchema = Type.Object(
  {
    id: AccountIdSchema,
    email: Type.String({ format: "email" }),
    displayName: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    linkedIdentities: Type.Array(LinkedIdentitySchema),
    sessions: Type.Array(AccountSessionSchema),
    createdAt: IsoTimestampSchema,
  },
  { additionalProperties: false },
);

export const InterviewMessageSchema = Type.Object(
  {
    id: MessageIdSchema,
    role: Type.Union([Type.Literal("user"), Type.Literal("interviewer")]),
    kind: Type.Union([
      Type.Literal("main_question"),
      Type.Literal("answer"),
      Type.Literal("supplement"),
      Type.Literal("clarification"),
      Type.Literal("follow_up"),
      Type.Literal("transition"),
    ]),
    text: Type.String({ minLength: 1 }),
    createdAt: IsoTimestampSchema,
  },
  { additionalProperties: false },
);

export const ActiveInterviewActionSchema = Type.Union([
  Type.Literal("submit_answer"),
  Type.Literal("submit_supplement"),
  Type.Literal("request_clarification"),
  Type.Literal("mark_unknown"),
  Type.Literal("skip"),
  Type.Literal("continue"),
  Type.Literal("end_early"),
  Type.Literal("abandon"),
  Type.Literal("retry"),
]);

const AwaitingResponseActionSchema = Type.Union([
  Type.Literal("submit_answer"),
  Type.Literal("request_clarification"),
  Type.Literal("mark_unknown"),
  Type.Literal("skip"),
  Type.Literal("end_early"),
  Type.Literal("abandon"),
]);

const AwaitingContinueActionSchema = Type.Union([
  Type.Literal("submit_supplement"),
  Type.Literal("continue"),
  Type.Literal("end_early"),
  Type.Literal("abandon"),
]);

const AwaitingResponseActionsSchema = Type.Array(AwaitingResponseActionSchema, {
  minItems: 1,
  uniqueItems: true,
});
const AwaitingContinueActionsSchema = Type.Array(AwaitingContinueActionSchema, {
  minItems: 1,
  uniqueItems: true,
});
const RetryableAwaitingResponseActionsSchema = Type.Array(
  Type.Union([AwaitingResponseActionSchema, Type.Literal("retry")]),
  {
    minItems: 1,
    uniqueItems: true,
    contains: Type.Literal("retry"),
  },
);
const RetryableAwaitingContinueActionsSchema = Type.Array(
  Type.Union([AwaitingContinueActionSchema, Type.Literal("retry")]),
  {
    minItems: 1,
    uniqueItems: true,
    contains: Type.Literal("retry"),
  },
);
const NoActionsSchema = Type.Array(Type.Never(), { maxItems: 0 });

export const ActiveInterviewProgressSchema = Type.Union([
  Type.Object(
    {
      current: Type.Integer({ minimum: 1, maximum: 5 }),
      total: Type.Literal(5),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      current: Type.Integer({ minimum: 1, maximum: 10 }),
      total: Type.Literal(10),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      current: Type.Integer({ minimum: 1, maximum: 15 }),
      total: Type.Literal(15),
    },
    { additionalProperties: false },
  ),
]);

export const PendingOperationReferenceSchema = Type.Object(
  {
    operationId: OperationIdSchema,
    status: Type.Literal("pending"),
  },
  { additionalProperties: false },
);

export const ProcessingOperationReferenceSchema = Type.Object(
  {
    operationId: OperationIdSchema,
    status: Type.Literal("processing"),
  },
  { additionalProperties: false },
);

export const CurrentOperationReferenceSchema = Type.Union([
  PendingOperationReferenceSchema,
  ProcessingOperationReferenceSchema,
]);

export const FailedOperationReferenceSchema = Type.Object(
  {
    operationId: OperationIdSchema,
    status: Type.Literal("failed"),
    failure: OperationFailureDetailSchema,
  },
  { additionalProperties: false },
);

const RetryableFailureDetailSchema = Type.Object(
  {
    code: OperationFailureCodeSchema,
    message: Type.String({ minLength: 1 }),
    retryable: Type.Literal(true),
  },
  { additionalProperties: false },
);

const NonRetryableFailureDetailSchema = Type.Object(
  {
    code: OperationFailureCodeSchema,
    message: Type.String({ minLength: 1 }),
    retryable: Type.Literal(false),
  },
  { additionalProperties: false },
);

const RetryableFailedOperationReferenceSchema = Type.Object(
  {
    operationId: OperationIdSchema,
    status: Type.Literal("failed"),
    failure: RetryableFailureDetailSchema,
  },
  { additionalProperties: false },
);

const NonRetryableFailedOperationReferenceSchema = Type.Object(
  {
    operationId: OperationIdSchema,
    status: Type.Literal("failed"),
    failure: NonRetryableFailureDetailSchema,
  },
  { additionalProperties: false },
);

const activeInterviewProperties = {
  id: InterviewIdSchema,
  status: Type.Literal("active"),
  version: InterviewVersionSchema,
  progress: ActiveInterviewProgressSchema,
  currentWording: Type.String({ minLength: 1 }),
  messages: Type.Array(InterviewMessageSchema),
  startedAt: IsoTimestampSchema,
  lastEffectiveActivityAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
} as const;

export const AwaitingResponseInterviewResponseSchema = Type.Union([
  Type.Object(
    {
      ...activeInterviewProperties,
      phase: Type.Literal("awaiting_response"),
      operation: CurrentOperationReferenceSchema,
      availableActions: NoActionsSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...activeInterviewProperties,
      phase: Type.Literal("awaiting_response"),
      availableActions: AwaitingResponseActionsSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...activeInterviewProperties,
      phase: Type.Literal("awaiting_response"),
      operation: RetryableFailedOperationReferenceSchema,
      availableActions: RetryableAwaitingResponseActionsSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...activeInterviewProperties,
      phase: Type.Literal("awaiting_response"),
      operation: NonRetryableFailedOperationReferenceSchema,
      availableActions: AwaitingResponseActionsSchema,
    },
    { additionalProperties: false },
  ),
]);

export const ProcessingInterviewResponseSchema = Type.Object(
  {
    ...activeInterviewProperties,
    phase: Type.Literal("processing"),
    operation: ProcessingOperationReferenceSchema,
    availableActions: NoActionsSchema,
  },
  { additionalProperties: false },
);

export const AwaitingContinueInterviewResponseSchema = Type.Union([
  Type.Object(
    {
      ...activeInterviewProperties,
      phase: Type.Literal("awaiting_continue"),
      availableActions: AwaitingContinueActionsSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...activeInterviewProperties,
      phase: Type.Literal("awaiting_continue"),
      operation: RetryableFailedOperationReferenceSchema,
      availableActions: RetryableAwaitingContinueActionsSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...activeInterviewProperties,
      phase: Type.Literal("awaiting_continue"),
      operation: NonRetryableFailedOperationReferenceSchema,
      availableActions: AwaitingContinueActionsSchema,
    },
    { additionalProperties: false },
  ),
]);

export const ActiveInterviewResponseSchema = Type.Union([
  AwaitingResponseInterviewResponseSchema,
  ProcessingInterviewResponseSchema,
  AwaitingContinueInterviewResponseSchema,
]);

const reportPendingProperties = {
  id: InterviewIdSchema,
  status: Type.Literal("report_pending"),
  reportKind: Type.Union([Type.Literal("complete"), Type.Literal("incomplete")]),
  version: InterviewVersionSchema,
  progress: ActiveInterviewProgressSchema,
  messages: Type.Array(InterviewMessageSchema),
  startedAt: IsoTimestampSchema,
  lastEffectiveActivityAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
} as const;

export const ReportPendingInterviewResponseSchema = Type.Union([
  Type.Object(
    {
      ...reportPendingProperties,
      availableActions: NoActionsSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...reportPendingProperties,
      operation: CurrentOperationReferenceSchema,
      availableActions: NoActionsSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...reportPendingProperties,
      operation: RetryableFailedOperationReferenceSchema,
      availableActions: Type.Array(Type.Literal("retry"), { minItems: 1, maxItems: 1 }),
    },
    { additionalProperties: false },
  ),
]);

const terminalInterviewProperties = {
  id: InterviewIdSchema,
  version: InterviewVersionSchema,
  questionCount: InterviewQuestionCountSchema,
  startedAt: IsoTimestampSchema,
  endedAt: IsoTimestampSchema,
  messages: Type.Array(InterviewMessageSchema),
} as const;

export const CompletedInterviewResponseSchema = Type.Object(
  {
    ...terminalInterviewProperties,
    status: Type.Literal("completed"),
    reportId: ReportIdSchema,
  },
  { additionalProperties: false },
);

export const EarlyEndedInterviewResponseSchema = Type.Object(
  {
    ...terminalInterviewProperties,
    status: Type.Literal("early_ended"),
    reportId: ReportIdSchema,
  },
  { additionalProperties: false },
);

export const AbandonedInterviewResponseSchema = Type.Object(
  {
    ...terminalInterviewProperties,
    status: Type.Literal("abandoned"),
  },
  { additionalProperties: false },
);

export const DeletingInterviewResponseSchema = Type.Object(
  {
    id: InterviewIdSchema,
    status: Type.Literal("deleting"),
    version: InterviewVersionSchema,
  },
  { additionalProperties: false },
);

export const CurrentInterviewResponseSchema = Type.Union([
  ActiveInterviewResponseSchema,
  ReportPendingInterviewResponseSchema,
]);

export const InterviewDetailResponseSchema = Type.Union([
  ActiveInterviewResponseSchema,
  ReportPendingInterviewResponseSchema,
  CompletedInterviewResponseSchema,
  EarlyEndedInterviewResponseSchema,
  AbandonedInterviewResponseSchema,
  DeletingInterviewResponseSchema,
]);

export const InterviewHistoryItemSchema = Type.Union([
  Type.Object(
    {
      id: InterviewIdSchema,
      status: Type.Literal("completed"),
      direction: Type.Literal("go_backend"),
      questionCount: InterviewQuestionCountSchema,
      startedAt: IsoTimestampSchema,
      endedAt: IsoTimestampSchema,
      overallScore: ScoreSchema,
      reportId: ReportIdSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      id: InterviewIdSchema,
      status: Type.Literal("early_ended"),
      direction: Type.Literal("go_backend"),
      questionCount: InterviewQuestionCountSchema,
      startedAt: IsoTimestampSchema,
      endedAt: IsoTimestampSchema,
      reportId: ReportIdSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      id: InterviewIdSchema,
      status: Type.Literal("abandoned"),
      direction: Type.Literal("go_backend"),
      questionCount: InterviewQuestionCountSchema,
      startedAt: IsoTimestampSchema,
      endedAt: IsoTimestampSchema,
    },
    { additionalProperties: false },
  ),
]);

export const InterviewHistoryResponseSchema = Type.Object(
  {
    items: Type.Array(InterviewHistoryItemSchema),
    pageInfo: PageInfoSchema,
  },
  { additionalProperties: false },
);

export const OperationResultReferenceSchema = Type.Object(
  {
    interviewId: InterviewIdSchema,
    interviewVersion: InterviewVersionSchema,
    reportId: Type.Union([ReportIdSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export const ReportOperationResultReferenceSchema = Type.Object(
  {
    reportId: ReportIdSchema,
  },
  { additionalProperties: false },
);

const operationStatusProperties = {
  operationId: OperationIdSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
} as const;

export const PendingOperationStatusResponseSchema = Type.Object(
  {
    ...operationStatusProperties,
    status: Type.Literal("pending"),
  },
  { additionalProperties: false },
);

export const ProcessingOperationStatusResponseSchema = Type.Object(
  {
    ...operationStatusProperties,
    status: Type.Literal("processing"),
  },
  { additionalProperties: false },
);

export const AcceptedOperationStatusResponseSchema = Type.Union([
  PendingOperationStatusResponseSchema,
  ProcessingOperationStatusResponseSchema,
]);

export const SucceededOperationStatusResponseSchema = Type.Object(
  {
    ...operationStatusProperties,
    status: Type.Literal("succeeded"),
    result: Type.Union([OperationResultReferenceSchema, ReportOperationResultReferenceSchema]),
  },
  { additionalProperties: false },
);

export const FailedOperationStatusResponseSchema = Type.Object(
  {
    ...operationStatusProperties,
    status: Type.Literal("failed"),
    failure: OperationFailureDetailSchema,
  },
  { additionalProperties: false },
);

export const OperationStatusResponseSchema = Type.Union([
  PendingOperationStatusResponseSchema,
  ProcessingOperationStatusResponseSchema,
  SucceededOperationStatusResponseSchema,
  FailedOperationStatusResponseSchema,
]);

export type LinkedIdentityDto = Static<typeof LinkedIdentitySchema>;
export type AccountSessionDto = Static<typeof AccountSessionSchema>;
export type AccountResponseDto = Static<typeof AccountResponseSchema>;
export type InterviewMessageDto = Static<typeof InterviewMessageSchema>;
export type ActiveInterviewActionDto = Static<typeof ActiveInterviewActionSchema>;
export type ActiveInterviewProgressDto = Static<typeof ActiveInterviewProgressSchema>;
export type PendingOperationReferenceDto = Static<typeof PendingOperationReferenceSchema>;
export type ProcessingOperationReferenceDto = Static<typeof ProcessingOperationReferenceSchema>;
export type CurrentOperationReferenceDto = Static<typeof CurrentOperationReferenceSchema>;
export type FailedOperationReferenceDto = Static<typeof FailedOperationReferenceSchema>;
export type AwaitingResponseInterviewResponseDto = Static<
  typeof AwaitingResponseInterviewResponseSchema
>;
export type ProcessingInterviewResponseDto = Static<typeof ProcessingInterviewResponseSchema>;
export type AwaitingContinueInterviewResponseDto = Static<
  typeof AwaitingContinueInterviewResponseSchema
>;
export type ActiveInterviewResponseDto = Static<typeof ActiveInterviewResponseSchema>;
export type ReportPendingInterviewResponseDto = Static<typeof ReportPendingInterviewResponseSchema>;
export type CompletedInterviewResponseDto = Static<typeof CompletedInterviewResponseSchema>;
export type EarlyEndedInterviewResponseDto = Static<typeof EarlyEndedInterviewResponseSchema>;
export type AbandonedInterviewResponseDto = Static<typeof AbandonedInterviewResponseSchema>;
export type DeletingInterviewResponseDto = Static<typeof DeletingInterviewResponseSchema>;
export type CurrentInterviewResponseDto = Static<typeof CurrentInterviewResponseSchema>;
export type InterviewDetailResponseDto = Static<typeof InterviewDetailResponseSchema>;
export type InterviewHistoryItemDto = Static<typeof InterviewHistoryItemSchema>;
export type InterviewHistoryResponseDto = Static<typeof InterviewHistoryResponseSchema>;
export type OperationResultReferenceDto = Static<typeof OperationResultReferenceSchema>;
export type ReportOperationResultReferenceDto = Static<typeof ReportOperationResultReferenceSchema>;
export type PendingOperationStatusResponseDto = Static<typeof PendingOperationStatusResponseSchema>;
export type ProcessingOperationStatusResponseDto = Static<
  typeof ProcessingOperationStatusResponseSchema
>;
export type AcceptedOperationStatusResponseDto = Static<
  typeof AcceptedOperationStatusResponseSchema
>;
export type SucceededOperationStatusResponseDto = Static<
  typeof SucceededOperationStatusResponseSchema
>;
export type FailedOperationStatusResponseDto = Static<typeof FailedOperationStatusResponseSchema>;
export type OperationStatusResponseDto = Static<typeof OperationStatusResponseSchema>;

export function isAccountResponseDto(value: unknown): value is AccountResponseDto {
  return Check(AccountResponseSchema, value);
}

export function isCurrentInterviewResponseDto(
  value: unknown,
): value is CurrentInterviewResponseDto {
  return Check(CurrentInterviewResponseSchema, value);
}

export function isInterviewDetailResponseDto(value: unknown): value is InterviewDetailResponseDto {
  return Check(InterviewDetailResponseSchema, value);
}

export function isInterviewHistoryResponseDto(
  value: unknown,
): value is InterviewHistoryResponseDto {
  return Check(InterviewHistoryResponseSchema, value);
}

export function isOperationStatusResponseDto(value: unknown): value is OperationStatusResponseDto {
  return Check(OperationStatusResponseSchema, value);
}
