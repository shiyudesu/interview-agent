import type { PgRepositoryUnitOfWork, StoredOperation } from "@interview-agent/db";
import { cancelInterviewOperation, completeInterviewOperation } from "@interview-agent/domain";

import {
  completionCommand,
  operationResult,
  reconstructPlan,
  retryOperationResult,
} from "./operation-command-codec.js";
import { publishOperationEvent } from "./operation-event-publication.js";
import type { OperationEventPublisher } from "./operation-events.js";
import { notBefore, requiredInterview, requiredOperation } from "./operation-guards.js";
import { completionLease } from "./operation-lease.js";
import type {
  ClaimedModelOperation,
  ModelCompletion,
  OperationFailure,
} from "./operation-types.js";

export class ModelOperationFinalizationService {
  constructor(
    private readonly unitOfWork: PgRepositoryUnitOfWork,
    private readonly now: () => Date,
    private readonly events: OperationEventPublisher,
  ) {}

  async complete(
    execution: ClaimedModelOperation,
    modelCompletion: ModelCompletion,
  ): Promise<StoredOperation> {
    const { claimed } = execution;
    const finalized = await this.unitOfWork.run(async (repositories) => {
      const operation = requiredOperation(
        await repositories.operations.findById(claimed.operation.id, claimed.operation.accountId),
        claimed.operation.id,
      );
      const interview = requiredInterview(
        await repositories.interviews.findById(
          claimed.operation.interviewId,
          claimed.operation.accountId,
        ),
        claimed.operation.interviewId,
      );
      const plan = reconstructPlan(interview, operation);
      const completedAt = notBefore(this.now(), plan.acceptedAt);
      const transition = completeInterviewOperation(
        interview,
        plan,
        completionCommand(operation, interview, modelCompletion, completedAt),
      );
      const completedOperation = await repositories.operations.completeSuccess({
        ...completionLease(claimed),
        operationId: operation.id,
        accountId: operation.accountId,
        result: operationResult(transition.interview),
      });
      const evaluationEvent = transition.events.find(
        (event) => event.type === "question_evaluation_recorded",
      );
      await repositories.interviews.save({
        previous: interview,
        current: transition.interview,
        events: transition.events,
        ...(evaluationEvent?.type === "question_evaluation_recorded" &&
        modelCompletion.kind === "evaluation"
          ? {
              evaluations: [
                {
                  evaluationId: evaluationEvent.evaluation.id,
                  questionPosition: evaluationEvent.questionPosition,
                  evaluation: evaluationEvent.evaluation,
                  modelMetadata: modelCompletion.evaluation.metadata,
                  createdAt: completedAt,
                },
              ],
            }
          : {}),
      });
      if (execution.retryCommand === undefined) {
        return {
          responseOperation: completedOperation,
          completedOperation,
          completedAt,
        };
      }
      const retryCommand = execution.retryCommand;
      const responseOperation = await repositories.operations.completeSuccess({
        ...completionLease(retryCommand),
        operationId: retryCommand.operation.id,
        accountId: retryCommand.operation.accountId,
        result: retryOperationResult(completedOperation, transition.interview),
      });
      return {
        responseOperation,
        completedOperation,
        completedAt,
      };
    });
    if (modelCompletion.kind === "clarification" || modelCompletion.kind === "follow_up") {
      publishOperationEvent(() =>
        this.events.publishTextAndTerminal(
          finalized.completedOperation,
          modelCompletion.text,
          finalized.completedAt,
        ),
      );
      if (finalized.responseOperation.id !== finalized.completedOperation.id) {
        publishOperationEvent(() =>
          this.events.publishTextAndTerminal(
            finalized.responseOperation,
            modelCompletion.text,
            finalized.completedAt,
          ),
        );
      }
    } else if (finalized.responseOperation.id !== finalized.completedOperation.id) {
      publishOperationEvent(() => this.events.publishTerminal(finalized.completedOperation));
    }
    return finalized.responseOperation;
  }

  async fail(
    execution: ClaimedModelOperation,
    failure: OperationFailure,
  ): Promise<StoredOperation> {
    const { claimed } = execution;
    const finalized = await this.unitOfWork.run(async (repositories) => {
      const operation = requiredOperation(
        await repositories.operations.findById(claimed.operation.id, claimed.operation.accountId),
        claimed.operation.id,
      );
      const interview = requiredInterview(
        await repositories.interviews.findById(operation.interviewId, operation.accountId),
        operation.interviewId,
      );
      const plan = reconstructPlan(interview, operation);
      const cancelled = cancelInterviewOperation(interview, plan);
      const failed = await repositories.operations.completeFailure({
        ...completionLease(claimed),
        operationId: operation.id,
        accountId: operation.accountId,
        error: failure,
        retryable: failure.retryable,
      });
      await repositories.interviews.save({
        previous: interview,
        current: cancelled,
        events: [],
      });
      const retryCommand = execution.retryCommand;
      if (retryCommand === undefined) {
        return {
          responseOperation: failed,
          failedOperation: failed,
        };
      }
      const responseOperation = await repositories.operations.completeFailure({
        ...completionLease(retryCommand),
        operationId: retryCommand.operation.id,
        accountId: retryCommand.operation.accountId,
        error: { ...failure, retryable: false },
        retryable: false,
      });
      return {
        responseOperation,
        failedOperation: failed,
      };
    });
    if (finalized.responseOperation.id !== finalized.failedOperation.id) {
      publishOperationEvent(() => this.events.publishTerminal(finalized.failedOperation));
    }
    return finalized.responseOperation;
  }
}
