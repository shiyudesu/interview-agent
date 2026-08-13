import type { PgRepositoryUnitOfWork, StoredOperation } from "@interview-agent/db";
import type {
  ReportAnalysisModel,
  ReportAnalysisRequest,
  ReportAnalysisResult,
} from "@interview-agent/domain";

import { publishOperationEvent } from "./operation-event-publication.js";
import type { OperationEventPublisher } from "./operation-events.js";
import { classifyReportFailure } from "./operation-failure.js";
import { requiredInterview, requiredOperation } from "./operation-guards.js";
import { createReportAnalysisRequest } from "./operation-report-builder.js";
import type { ClaimedReportOperation } from "./operation-types.js";
import { assertReportOperationMatchesInterview } from "./report-operation-codec.js";
import type { ReportOperationFinalizationService } from "./report-operation-finalization.js";

export class ReportOperationExecutionService {
  constructor(
    private readonly unitOfWork: PgRepositoryUnitOfWork,
    private readonly reportAnalyzer: ReportAnalysisModel,
    private readonly finalization: ReportOperationFinalizationService,
    private readonly events: OperationEventPublisher,
  ) {}

  async execute(execution: ClaimedReportOperation): Promise<StoredOperation> {
    publishOperationEvent(() => this.events.beginAttempt(execution.claimed.operation));
    let request: ReportAnalysisRequest;
    try {
      request = await this.unitOfWork.run(async (repositories) => {
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
        return createReportAnalysisRequest(interview);
      });
    } catch (error) {
      const failure = classifyReportFailure(error);
      if (failure === null) {
        throw error;
      }
      return this.finalization.fail(execution, failure);
    }

    let analysis: ReportAnalysisResult;
    try {
      analysis = await this.reportAnalyzer.analyze(request);
    } catch (error) {
      const failure = classifyReportFailure(error);
      if (failure === null) {
        throw error;
      }
      return this.finalization.fail(execution, failure);
    }

    try {
      return await this.finalization.complete(execution, analysis);
    } catch (error) {
      const failure = classifyReportFailure(error);
      if (failure === null) {
        throw error;
      }
      return this.finalization.fail(execution, failure);
    }
  }
}
