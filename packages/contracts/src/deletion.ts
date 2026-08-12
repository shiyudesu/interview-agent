import { type Static, Type } from "typebox";

import { InterviewIdSchema, IsoTimestampSchema } from "./common.js";
import {
  InternalApiErrorSchema,
  UnauthorizedApiErrorSchema,
  ValidationApiErrorSchema,
} from "./errors.js";

export const InterviewDeletionParamsSchema = Type.Object(
  {
    interviewId: InterviewIdSchema,
  },
  { additionalProperties: false },
);

export const ConfirmDeletionRequestSchema = Type.Object(
  {
    confirmed: Type.Literal(true),
  },
  { additionalProperties: false },
);

export const DeletionAcceptedResponseSchema = Type.Object(
  {
    status: Type.Literal("deleting"),
    requestedAt: IsoTimestampSchema,
    purgeDeadlineAt: IsoTimestampSchema,
  },
  { additionalProperties: false },
);

export const DeletionValidationErrorResponseSchema = Type.Object(
  {
    error: ValidationApiErrorSchema,
  },
  { additionalProperties: false },
);

export const DeletionUnauthorizedResponseSchema = Type.Object(
  {
    error: UnauthorizedApiErrorSchema,
  },
  { additionalProperties: false },
);

function deletionNotFoundResponseSchema(resource: "account" | "interview") {
  return Type.Object(
    {
      error: Type.Object(
        {
          code: Type.Literal("not_found"),
          message: Type.String({ minLength: 1 }),
          resource: Type.Literal(resource),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  );
}

export const InterviewDeletionNotFoundResponseSchema = deletionNotFoundResponseSchema("interview");

export const AccountDeletionNotFoundResponseSchema = deletionNotFoundResponseSchema("account");

export const DeletionFailureResponseSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.Literal("deletion_failure"),
        message: Type.Literal("Deletion request failed"),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const DeletionInternalFailureResponseSchema = Type.Object(
  {
    error: InternalApiErrorSchema,
  },
  { additionalProperties: false },
);

export const DeletionServerFailureResponseSchema = Type.Union([
  DeletionFailureResponseSchema,
  DeletionInternalFailureResponseSchema,
]);

export type InterviewDeletionParamsDto = Static<typeof InterviewDeletionParamsSchema>;
export type ConfirmDeletionRequestDto = Static<typeof ConfirmDeletionRequestSchema>;
export type DeletionAcceptedResponseDto = Static<typeof DeletionAcceptedResponseSchema>;
export type DeletionValidationErrorResponseDto = Static<
  typeof DeletionValidationErrorResponseSchema
>;
export type DeletionUnauthorizedResponseDto = Static<typeof DeletionUnauthorizedResponseSchema>;
export type InterviewDeletionNotFoundResponseDto = Static<
  typeof InterviewDeletionNotFoundResponseSchema
>;
export type AccountDeletionNotFoundResponseDto = Static<
  typeof AccountDeletionNotFoundResponseSchema
>;
export type DeletionFailureResponseDto = Static<typeof DeletionFailureResponseSchema>;
export type DeletionInternalFailureResponseDto = Static<
  typeof DeletionInternalFailureResponseSchema
>;
export type DeletionServerFailureResponseDto = Static<typeof DeletionServerFailureResponseSchema>;
