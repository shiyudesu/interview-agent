import type { PgRepositoryUnitOfWork, StoredOperation } from "@interview-agent/db";
import type {
  AnswerEvaluationModel,
  InterviewerTextModel,
  ReportAnalysisModel,
} from "@interview-agent/domain";
import { ModelOperationExecutionService } from "./model-operation-execution.js";
import { ModelOperationFinalizationService } from "./model-operation-finalization.js";
import { OperationAcceptanceService } from "./operation-acceptance.js";
import { NO_OPERATION_EVENTS } from "./operation-event-publication.js";
import type { OperationEventPublisher } from "./operation-events.js";
import { DEFAULT_OPERATION_LEASE_MS } from "./operation-lease.js";
import { OperationRetryAcceptanceService } from "./operation-retry-acceptance.js";
import type {
  AcceptedOperationExecution,
  ClaimedModelOperation,
  ClaimedReportOperation,
  CreateInterviewOperationInput,
  OperationRunnerOptions,
  PreparedOperation,
  ProgressCommandRequest,
  RetryInterviewOperationInput,
} from "./operation-types.js";
import { ReportOperationExecutionService } from "./report-operation-execution.js";
import { ReportOperationFinalizationService } from "./report-operation-finalization.js";
import {
  completeOperationTelemetrySpan,
  operationTelemetryAttributes,
  withTelemetrySpan,
} from "./telemetry.js";

export class OperationRunner {
  private readonly acceptance: OperationAcceptanceService;
  private readonly retryAcceptance: OperationRetryAcceptanceService;
  private readonly modelExecution: ModelOperationExecutionService;
  private readonly reportExecution: ReportOperationExecutionService;
  readonly events: OperationEventPublisher;

  constructor(
    unitOfWork: PgRepositoryUnitOfWork,
    interviewer: InterviewerTextModel,
    evaluator: AnswerEvaluationModel,
    reportAnalyzer: ReportAnalysisModel,
    options: OperationRunnerOptions,
  ) {
    const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_OPERATION_LEASE_MS;
    const now = options.now ?? (() => new Date());
    this.events = options.events ?? NO_OPERATION_EVENTS;
    this.acceptance = new OperationAcceptanceService(
      unitOfWork,
      options.leaseOwner,
      leaseDurationMs,
    );
    this.retryAcceptance = new OperationRetryAcceptanceService(
      unitOfWork,
      options.leaseOwner,
      leaseDurationMs,
    );
    this.modelExecution = new ModelOperationExecutionService(
      interviewer,
      evaluator,
      new ModelOperationFinalizationService(unitOfWork, now, this.events),
      this.events,
    );
    this.reportExecution = new ReportOperationExecutionService(
      unitOfWork,
      reportAnalyzer,
      new ReportOperationFinalizationService(unitOfWork, now, this.events),
      this.events,
    );
  }

  createInterview(input: CreateInterviewOperationInput): Promise<StoredOperation> {
    return withTelemetrySpan(
      "interview.operation.accept",
      operationTelemetryAttributes(
        {
          id: input.operationId,
          interviewId: input.interviewId,
          type: "create_interview",
          expectedVersion: input.expectedVersion,
        },
        false,
      ),
      async (span) => {
        const operation = await this.acceptance.createInterview(input);
        completeOperationTelemetrySpan(span, operation, false);
        return operation;
      },
    );
  }

  async run(request: ProgressCommandRequest): Promise<StoredOperation> {
    return this.executeAccepted(await this.accept(request));
  }

  async accept(request: ProgressCommandRequest): Promise<AcceptedOperationExecution> {
    return withTelemetrySpan(
      "interview.operation.accept",
      operationTelemetryAttributes(
        {
          id: request.operationId,
          interviewId: request.interviewId,
          type: request.type,
          expectedVersion: request.expectedVersion,
        },
        false,
      ),
      async (span) => {
        const accepted = this.acceptPrepared(await this.acceptance.acceptProgress(request));
        completeOperationTelemetrySpan(span, accepted.operation, false);
        return accepted;
      },
    );
  }

  async retry(input: RetryInterviewOperationInput): Promise<StoredOperation> {
    return this.executeAccepted(await this.acceptRetry(input));
  }

  async acceptRetry(input: RetryInterviewOperationInput): Promise<AcceptedOperationExecution> {
    return withTelemetrySpan(
      "interview.operation.accept",
      {
        ...operationTelemetryAttributes(
          {
            id: input.operationId,
            interviewId: input.interviewId,
            type: "retry_operation",
            expectedVersion: input.expectedVersion,
          },
          true,
        ),
        "interview.operation.target_id": input.targetOperationId,
      },
      async (span) => {
        const accepted = this.acceptPrepared(await this.retryAcceptance.accept(input));
        completeOperationTelemetrySpan(span, accepted.operation, false);
        return accepted;
      },
    );
  }

  private acceptPrepared(prepared: PreparedOperation): AcceptedOperationExecution {
    if (prepared.kind === "canonical") {
      return canonicalExecution(prepared.operation);
    }
    if (prepared.kind === "model") {
      return acceptedExecution(responseOperation(prepared.execution), () =>
        this.executeModelOperation(prepared.execution),
      );
    }
    return acceptedExecution(responseOperation(prepared.execution), () =>
      this.executeReportOperation(prepared.execution),
    );
  }

  private executeModelOperation(execution: ClaimedModelOperation): Promise<StoredOperation> {
    return this.executeOperation(
      execution.claimed.operation,
      execution.retryCommand !== undefined,
      () => this.modelExecution.execute(execution),
    );
  }

  private executeReportOperation(execution: ClaimedReportOperation): Promise<StoredOperation> {
    return this.executeOperation(
      execution.claimed.operation,
      execution.retryCommand !== undefined,
      () => this.reportExecution.execute(execution),
    );
  }

  private executeOperation(
    operation: StoredOperation,
    retry: boolean,
    execute: () => Promise<StoredOperation>,
  ): Promise<StoredOperation> {
    return withTelemetrySpan(
      "interview.operation.execute",
      operationTelemetryAttributes(operation, retry),
      async (span) => {
        const result = await execute();
        completeOperationTelemetrySpan(span, result, true);
        return result;
      },
    );
  }

  private executeAccepted(accepted: AcceptedOperationExecution): Promise<StoredOperation> {
    return accepted.work?.start() ?? Promise.resolve(accepted.operation);
  }
}

function canonicalExecution(operation: StoredOperation): AcceptedOperationExecution {
  return { operation, work: null };
}

function acceptedExecution(
  operation: StoredOperation,
  execute: () => Promise<StoredOperation>,
): AcceptedOperationExecution {
  let started: Promise<StoredOperation> | null = null;
  return {
    operation,
    work: {
      operationId: operation.id,
      start() {
        started ??= execute();
        return started;
      },
    },
  };
}

function responseOperation(
  execution: ClaimedModelOperation | ClaimedReportOperation,
): StoredOperation {
  return execution.retryCommand?.operation ?? execution.claimed.operation;
}

export { InterviewOperationHandlers } from "./interview-operation-handlers.js";
export { OperationRunnerError } from "./operation-errors.js";
export type {
  OperationExecution,
  OperationExecutionStarter,
} from "./operation-execution-supervisor.js";
export {
  ServerOwnedOperationExecution,
  ServerOwnedOperationStarter,
  ServerOwnedOperationSupervisor,
} from "./operation-execution-supervisor.js";
export {
  INTERVIEW_COMMAND_IDEMPOTENCY_SCOPE,
  REPORT_GENERATION_IDEMPOTENCY_SCOPE,
} from "./operation-scopes.js";
export type {
  AcceptedOperationExecution,
  AcceptedOperationWork,
  CreateInterviewOperationInput,
  OperationCommandInput,
  OperationRunnerOptions,
  ProgressCommandRequest,
  RetryInterviewOperationInput,
  TextInterviewOperationInput,
} from "./operation-types.js";
