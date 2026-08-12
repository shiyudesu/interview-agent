import type { OperationId } from "@interview-agent/domain";
import { parseMappedDto, serializeIsoTimestamp } from "./mapping-validation.js";
import {
  type OperationTerminalEventDto,
  OperationTerminalEventSchema,
  type OperationTextDeltaEventDto,
  OperationTextDeltaEventSchema,
} from "./operation-events.js";
import {
  mapOperationToStatusResponse,
  type PersistedOperationProjection,
} from "./operation-response-mappings.js";

export function mapOperationTextDeltaEvent(
  operationId: OperationId,
  sequence: number,
  text: string,
  occurredAt: Date,
): OperationTextDeltaEventDto {
  return parseMappedDto(
    OperationTextDeltaEventSchema,
    {
      operationId: String(operationId),
      sequence,
      occurredAt: serializeIsoTimestamp(occurredAt, "operation event occurredAt"),
      type: "text_delta",
      text,
    },
    "Operation text delta event",
  );
}

export function mapOperationToTerminalEvent(
  operation: PersistedOperationProjection,
  sequence: number,
): OperationTerminalEventDto | null {
  const status = mapOperationToStatusResponse(operation);
  if (status.status === "pending" || status.status === "processing") {
    return null;
  }
  return parseMappedDto(
    OperationTerminalEventSchema,
    {
      operationId: status.operationId,
      sequence,
      occurredAt: serializeIsoTimestamp(
        operation.completedAt ?? operation.updatedAt,
        "operation event occurredAt",
      ),
      type: status.status,
      ...(status.status === "failed" ? { failure: status.failure } : {}),
    },
    "Operation terminal event",
  );
}
