import type { JsonObject, StoredOperation } from "@interview-agent/db";
import type { Interview, ReportKind } from "@interview-agent/domain";

import { OperationRunnerError } from "./operation-errors.js";

export function reportOperationInput(reportKind: ReportKind, requestedAt: Date): JsonObject {
  return {
    reportKind,
    reportRequestedAt: requestedAt.toISOString(),
  };
}

export function requiredReportKind(operation: StoredOperation): ReportKind {
  const value = operation.input["reportKind"];
  if (value !== "complete" && value !== "incomplete") {
    throw new OperationRunnerError(`Operation ${operation.id} has an invalid report kind`);
  }
  return value;
}

export function assertReportOperationMatchesInterview(
  interview: Interview,
  operation: StoredOperation,
): void {
  if (
    operation.type !== "generate_report" ||
    operation.interviewId !== interview.id ||
    operation.accountId !== interview.accountId ||
    interview.status !== "report_pending" ||
    interview.pendingReportKind === null ||
    interview.pendingReportKind !== requiredReportKind(operation) ||
    operation.expectedVersion !== interview.version ||
    interview.reportRequestedAt === null ||
    operation.input["reportRequestedAt"] !== interview.reportRequestedAt.toISOString()
  ) {
    throw new OperationRunnerError(
      `Operation ${operation.id} does not match report-pending interview ${interview.id}`,
    );
  }
}
