import { type Static, Type } from "typebox";

import { IsoTimestampSchema, OperationIdSchema } from "./common.js";
import { OperationFailureDetailSchema } from "./errors.js";

export const OperationEventSequenceSchema = Type.Integer({ minimum: 0 });
export const LastOperationEventIdSchema = Type.String({
  maxLength: 16,
  pattern: "^(0|[1-9][0-9]*)$",
});

const operationEventCommon = {
  operationId: OperationIdSchema,
  sequence: OperationEventSequenceSchema,
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

export const OperationTerminalEventSchema = Type.Union([
  OperationSucceededEventSchema,
  OperationFailedEventSchema,
]);

export const OperationEventSchema = Type.Union([
  OperationTextDeltaEventSchema,
  OperationTerminalEventSchema,
]);

export const OperationEventStreamHeadersSchema = Type.Object(
  {
    "last-event-id": Type.Optional(LastOperationEventIdSchema),
  },
  { additionalProperties: true },
);

export type OperationTextDeltaEventDto = Static<typeof OperationTextDeltaEventSchema>;
export type OperationSucceededEventDto = Static<typeof OperationSucceededEventSchema>;
export type OperationFailedEventDto = Static<typeof OperationFailedEventSchema>;
export type OperationTerminalEventDto = Static<typeof OperationTerminalEventSchema>;
export type OperationEventDto = Static<typeof OperationEventSchema>;
export type OperationEventStreamHeadersDto = Static<typeof OperationEventStreamHeadersSchema>;
