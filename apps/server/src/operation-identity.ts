import { createHash } from "node:crypto";
import {
  type AnswerMaterialId,
  type OperationId,
  parseAnswerMaterialId,
  parseOperationId,
  parseReportId,
  type ReportId,
} from "@interview-agent/domain";

export function answerMaterialId(operationId: OperationId): AnswerMaterialId {
  return parseAnswerMaterialId(derivedIdentifier("answer", operationId));
}

export function reportOperationIdFor(operationId: OperationId): OperationId {
  return parseOperationId(derivedIdentifier("report-operation", operationId));
}

export function reportIdFor(operationId: OperationId): ReportId {
  return parseReportId(derivedIdentifier("report", operationId));
}

export function derivedIdentifier(kind: string, operationId: OperationId): string {
  const hash = createHash("sha256").update(`${kind}:${operationId}`).digest("hex");
  return `${kind}-${hash}`;
}
