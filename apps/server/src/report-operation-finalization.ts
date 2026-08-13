import type { PgRepositoryUnitOfWork, StoredOperation } from "@interview-agent/db";
import { handleInterviewCommand, type ReportAnalysisResult } from "@interview-agent/domain";

import { retryOperationResult } from "./operation-command-codec.js";
import { OperationRunnerError } from "./operation-errors.js";
import { publishOperationEvent } from "./operation-event-publication.js";
import type { OperationEventPublisher } from "./operation-events.js";
import { notBefore, requiredInterview, requiredOperation } from "./operation-guards.js";
import { reportIdFor } from "./operation-identity.js";
import { completionLease } from "./operation-lease.js";
import { createReportPersistence } from "./operation-report-builder.js";
import type { ClaimedReportOperation, OperationFailure } from "./operation-types.js";
import {
  assertReportOperationMatchesInterview,
  requiredReportKind,
} from "./report-operation-codec.js";

export class ReportOperationFinalizationService {
  constructor(
    private readonly unitOfWork: PgRepositoryUnitOfWork,
    private readonly now: () => Date,
    private readonly events: OperationEventPublisher,
  ) {}

  async complete(
    execution: ClaimedReportOperation,
    analysis: ReportAnalysisResult,
  ): Promise<StoredOperation> {
    const finalized = await this.unitOfWork.run(async (repositories) => {
      const operation = requiredOperation(
        await repositories.operations.findById(
          execution.claimed.operation.id,
          execution.claimed.operation.accountId,
        ),
        execution.claimed.operation.id,
      );
      const interview = requiredInterview(
        await repositories.interviews.findById(operation.interviewId, operation.accountId),
        operation.interviewId,
      );
      assertReportOperationMatchesInterview(interview, operation);
      const reportKind = requiredReportKind(operation);
      const completedAt = notBefore(
        notBefore(this.now(), interview.reportRequestedAt ?? operation.createdAt),
        interview.lastEffectiveActivityAt,
      );
      const reportId = reportIdFor(operation.id);
      const report = createReportPersistence(
        interview,
        reportKind,
        reportId,
        completedAt,
        analysis,
      );
      const transition = handleInterviewCommand(interview, {
        type: "record_report",
        interviewId: interview.id,
        operationId: operation.id,
        expectedVersion: interview.version,
        occurredAt: completedAt,
        reportId,
        reportKind,
      });
      if (transition.kind !== "transition") {
        throw new OperationRunnerError("Report completion did not produce a transition");
      }

      const completedOperation = await repositories.operations.completeSuccess({
        ...completionLease(execution.claimed),
        operationId: operation.id,
        accountId: operation.accountId,
        result: { reportId: String(reportId) },
      });
      await repositories.interviews.save({
        previous: interview,
        current: transition.interview,
        events: transition.events,
        report,
      });

      if (execution.retryCommand === undefined) {
        return {
          responseOperation: completedOperation,
          completedOperation,
        };
      }
      const responseOperation = await repositories.operations.completeSuccess({
        ...completionLease(execution.retryCommand),
        operationId: execution.retryCommand.operation.id,
        accountId: execution.retryCommand.operation.accountId,
        result: retryOperationResult(completedOperation, transition.interview),
      });
      return {
        responseOperation,
        completedOperation,
      };
    });

    publishOperationEvent(() => this.events.publishTerminal(finalized.completedOperation));
    if (finalized.responseOperation.id !== finalized.completedOperation.id) {
      publishOperationEvent(() => this.events.publishTerminal(finalized.responseOperation));
    }
    return finalized.responseOperation;
  }

  async fail(
    execution: ClaimedReportOperation,
    failure: OperationFailure,
  ): Promise<StoredOperation> {
    const finalized = await this.unitOfWork.run(async (repositories) => {
      const failedOperation = await repositories.operations.completeFailure({
        ...completionLease(execution.claimed),
        operationId: execution.claimed.operation.id,
        accountId: execution.claimed.operation.accountId,
        error: failure,
        retryable: true,
      });
      if (execution.retryCommand === undefined) {
        return {
          responseOperation: failedOperation,
          failedOperation,
        };
      }
      const responseOperation = await repositories.operations.completeFailure({
        ...completionLease(execution.retryCommand),
        operationId: execution.retryCommand.operation.id,
        accountId: execution.retryCommand.operation.accountId,
        error: { ...failure, retryable: false },
        retryable: false,
      });
      return {
        responseOperation,
        failedOperation,
      };
    });

    publishOperationEvent(() => this.events.publishTerminal(finalized.failedOperation));
    if (finalized.responseOperation.id !== finalized.failedOperation.id) {
      publishOperationEvent(() => this.events.publishTerminal(finalized.responseOperation));
    }
    return finalized.responseOperation;
  }
}
