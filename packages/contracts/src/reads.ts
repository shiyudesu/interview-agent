import { type Static, Type } from "typebox";

import { InterviewIdSchema, OperationIdSchema } from "./common.js";

export const InterviewReadParamsSchema = Type.Object(
  {
    interviewId: InterviewIdSchema,
  },
  { additionalProperties: false },
);

export const OperationReadParamsSchema = Type.Object(
  {
    operationId: OperationIdSchema,
  },
  { additionalProperties: false },
);

export type InterviewReadParamsDto = Static<typeof InterviewReadParamsSchema>;
export type OperationReadParamsDto = Static<typeof OperationReadParamsSchema>;
