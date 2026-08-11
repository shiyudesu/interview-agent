import { type Static, Type } from "typebox";

import { IsoTimestampSchema } from "./common.js";

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

export type ConfirmDeletionRequestDto = Static<typeof ConfirmDeletionRequestSchema>;
export type DeletionAcceptedResponseDto = Static<typeof DeletionAcceptedResponseSchema>;
export type DeletionFailureResponseDto = Static<typeof DeletionFailureResponseSchema>;
