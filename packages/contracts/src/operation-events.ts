import { type Static, Type } from "typebox";

import { IsoTimestampSchema, OperationIdSchema } from "./common.js";
import { OperationFailureDetailSchema } from "./errors.js";

const operationEventCommon = {
  operationId: OperationIdSchema,
  sequence: Type.Integer({ minimum: 0 }),
  occurredAt: IsoTimestampSchema,
} as const;

export const OperationTextDeltaEventSchema = Type.Object(
  {
    ...operationEventCommon,
    type: Type.Literal("text_delta"),
    text: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const OperationSucceededEventSchema = Type.Object(
  {
    ...operationEventCommon,
    type: Type.Literal("succeeded"),
  },
  { additionalProperties: false },
);

export const OperationFailedEventSchema = Type.Object(
  {
    ...operationEventCommon,
    type: Type.Literal("failed"),
    failure: OperationFailureDetailSchema,
  },
  { additionalProperties: false },
);

export const OperationEventSchema = Type.Union([
  OperationTextDeltaEventSchema,
  OperationSucceededEventSchema,
  OperationFailedEventSchema,
]);

export type OperationTextDeltaEventDto = Static<typeof OperationTextDeltaEventSchema>;
export type OperationSucceededEventDto = Static<typeof OperationSucceededEventSchema>;
export type OperationFailedEventDto = Static<typeof OperationFailedEventSchema>;
export type OperationEventDto = Static<typeof OperationEventSchema>;
