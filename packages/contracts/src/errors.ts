import { type Static, Type } from "typebox";

import {
  InterviewIdSchema,
  InterviewPhaseSchema,
  InterviewStatusSchema,
  InterviewVersionSchema,
  OperationIdSchema,
} from "./common.js";

export const OperationFailureCodeSchema = Type.Union([
  Type.Literal("operation_failed"),
  Type.Literal("model_failure"),
]);

export const OperationFailureDetailSchema = Type.Object(
  {
    code: OperationFailureCodeSchema,
    message: Type.String({ minLength: 1 }),
    retryable: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const ValidationIssueSchema = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
    code: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const ValidationApiErrorSchema = Type.Object(
  {
    code: Type.Literal("validation_error"),
    message: Type.String({ minLength: 1 }),
    issues: Type.Array(ValidationIssueSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export const UnauthorizedApiErrorSchema = Type.Object(
  {
    code: Type.Literal("unauthorized"),
    message: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const NotFoundApiErrorSchema = Type.Object(
  {
    code: Type.Literal("not_found"),
    message: Type.String({ minLength: 1 }),
    resource: Type.Union([
      Type.Literal("account"),
      Type.Literal("interview"),
      Type.Literal("operation"),
      Type.Literal("report"),
    ]),
  },
  { additionalProperties: false },
);

export const CanonicalInterviewStateSchema = Type.Union([
  Type.Object(
    {
      status: Type.Literal("active"),
      phase: InterviewPhaseSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      status: Type.Exclude(InterviewStatusSchema, Type.Literal("active")),
      phase: Type.Null(),
    },
    { additionalProperties: false },
  ),
]);

export const VersionConflictApiErrorSchema = Type.Object(
  {
    code: Type.Literal("version_conflict"),
    message: Type.String({ minLength: 1 }),
    interviewId: InterviewIdSchema,
    currentVersion: InterviewVersionSchema,
    currentState: CanonicalInterviewStateSchema,
  },
  { additionalProperties: false },
);

export const CommandRejectedApiErrorSchema = Type.Object(
  {
    code: Type.Literal("command_rejected"),
    message: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const OperationFailureApiErrorSchema = Type.Object(
  {
    code: Type.Literal("operation_failure"),
    operationId: OperationIdSchema,
    failure: OperationFailureDetailSchema,
  },
  { additionalProperties: false },
);

export const OperationEventReplayUnavailableApiErrorSchema = Type.Object(
  {
    code: Type.Literal("operation_event_replay_unavailable"),
    message: Type.String({ minLength: 1 }),
    operationId: OperationIdSchema,
  },
  { additionalProperties: false },
);

export const OperationFailedApiErrorSchema = OperationFailureApiErrorSchema;
export const ModelFailureApiErrorSchema = OperationFailureApiErrorSchema;

export const InternalApiErrorSchema = Type.Object(
  {
    code: Type.Literal("internal_error"),
    message: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const ApiErrorSchema = Type.Union([
  ValidationApiErrorSchema,
  UnauthorizedApiErrorSchema,
  NotFoundApiErrorSchema,
  VersionConflictApiErrorSchema,
  CommandRejectedApiErrorSchema,
  OperationFailureApiErrorSchema,
  OperationEventReplayUnavailableApiErrorSchema,
  InternalApiErrorSchema,
]);

export const ErrorEnvelopeSchema = Type.Object(
  {
    error: ApiErrorSchema,
  },
  { additionalProperties: false },
);

export type ValidationIssueDto = Static<typeof ValidationIssueSchema>;
export type ValidationApiErrorDto = Static<typeof ValidationApiErrorSchema>;
export type UnauthorizedApiErrorDto = Static<typeof UnauthorizedApiErrorSchema>;
export type NotFoundApiErrorDto = Static<typeof NotFoundApiErrorSchema>;
export type CanonicalInterviewStateDto = Static<typeof CanonicalInterviewStateSchema>;
export type VersionConflictApiErrorDto = Static<typeof VersionConflictApiErrorSchema>;
export type CommandRejectedApiErrorDto = Static<typeof CommandRejectedApiErrorSchema>;
export type OperationFailureCodeDto = Static<typeof OperationFailureCodeSchema>;
export type OperationFailureDetailDto = Static<typeof OperationFailureDetailSchema>;
export type OperationFailureApiErrorDto = Static<typeof OperationFailureApiErrorSchema>;
export type OperationEventReplayUnavailableApiErrorDto = Static<
  typeof OperationEventReplayUnavailableApiErrorSchema
>;
export type OperationFailedApiErrorDto = Static<typeof OperationFailedApiErrorSchema>;
export type ModelFailureApiErrorDto = Static<typeof ModelFailureApiErrorSchema>;
export type InternalApiErrorDto = Static<typeof InternalApiErrorSchema>;
export type ApiErrorDto = Static<typeof ApiErrorSchema>;
export type ErrorEnvelopeDto = Static<typeof ErrorEnvelopeSchema>;
