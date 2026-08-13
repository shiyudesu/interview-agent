import {
  type ClaimedOperation,
  type PgRepositoryUnitOfWork,
  RepositoryInterviewUnavailableError,
  RepositoryNotFoundError,
  RepositoryOperationRetryConflictError,
  type StoredOperation,
} from "@interview-agent/db";
import {
  InterviewDomainError,
  InterviewVersionConflictError,
  refreshInterviewOperation,
  refreshReportRetryActivity,
  retryInterviewOperation,
} from "@interview-agent/domain";

import { decodePlannedCommand, reconstructPlan } from "./operation-command-codec.js";
import { OperationRunnerError } from "./operation-errors.js";
import { operationFailure } from "./operation-failure.js";
import { requiredDate, requiredInterview, requiredOperation } from "./operation-guards.js";
import { completionLease, operationClaimInput } from "./operation-lease.js";
import { INTERVIEW_COMMAND_IDEMPOTENCY_SCOPE } from "./operation-scopes.js";
import type { PreparedOperation, RetryInterviewOperationInput } from "./operation-types.js";
import { assertReportOperationMatchesInterview } from "./report-operation-codec.js";

export class OperationRetryAcceptanceService {
  constructor(
    private readonly unitOfWork: PgRepositoryUnitOfWork,
    private readonly leaseOwner: string,
    private readonly leaseDurationMs: number,
  ) {}

  async accept(input: RetryInterviewOperationInput): Promise<PreparedOperation> {
    const retryOperation = await this.unitOfWork.run((repositories) =>
      repositories.operations.createOrLoad({
        id: input.operationId,
        accountId: input.accountId,
        interviewId: input.interviewId,
        idempotencyScope: INTERVIEW_COMMAND_IDEMPOTENCY_SCOPE,
        type: "retry_operation",
        idempotencyKey: input.idempotencyKey,
        expectedVersion: input.expectedVersion,
        input: { targetOperationId: String(input.targetOperationId) },
        createdAt: input.occurredAt,
      }),
    );
    const canonicalRetry = retryOperation.operation;
    if (canonicalRetry.status === "succeeded" || canonicalRetry.status === "failed") {
      return { kind: "canonical", operation: canonicalRetry };
    }

    try {
      return await this.unitOfWork.run(async (repositories) => {
        const currentRetry = requiredOperation(
          await repositories.operations.findById(canonicalRetry.id, canonicalRetry.accountId),
          canonicalRetry.id,
        );
        if (currentRetry.status === "succeeded" || currentRetry.status === "failed") {
          return { kind: "canonical", operation: currentRetry };
        }
        let retryCommand: ClaimedOperation | null;
        if (currentRetry.status === "pending") {
          retryCommand = await repositories.operations.claimPending(this.claimInput(currentRetry));
        } else {
          try {
            retryCommand = await repositories.operations.reclaimStaleProcessing({
              ...this.claimInput(currentRetry),
              input: currentRetry.input,
            });
          } catch (error) {
            if (error instanceof RepositoryOperationRetryConflictError) {
              return { kind: "canonical", operation: currentRetry };
            }
            throw error;
          }
        }
        if (retryCommand === null) {
          return {
            kind: "canonical",
            operation: requiredOperation(
              await repositories.operations.findById(canonicalRetry.id, canonicalRetry.accountId),
              canonicalRetry.id,
            ),
          };
        }

        const target = requiredOperation(
          await repositories.operations.findById(input.targetOperationId, input.accountId),
          input.targetOperationId,
        );
        if (
          target.interviewId !== input.interviewId ||
          (target.type !== "submit_answer" &&
            target.type !== "submit_supplement" &&
            target.type !== "request_question_clarification" &&
            target.type !== "generate_report")
        ) {
          throw new RepositoryOperationRetryConflictError(input.targetOperationId);
        }
        const interview = requiredInterview(
          await repositories.interviews.findById(input.interviewId, input.accountId),
          input.interviewId,
        );
        if (interview.version !== input.expectedVersion) {
          throw new InterviewVersionConflictError(input.expectedVersion, interview.version);
        }

        const claimed =
          target.status === "failed"
            ? await repositories.operations.retryFailedAndClaim({
                ...this.claimInput(
                  target,
                  requiredDate(retryCommand.operation.leaseExpiresAt, "retry command lease expiry"),
                ),
                input: target.input,
              })
            : target.status === "processing"
              ? await repositories.operations.reclaimStaleProcessing({
                  ...this.claimInput(
                    target,
                    requiredDate(
                      retryCommand.operation.leaseExpiresAt,
                      "retry command lease expiry",
                    ),
                  ),
                  input: target.input,
                })
              : null;
        if (claimed === null) {
          throw new RepositoryOperationRetryConflictError(input.targetOperationId);
        }

        if (target.type === "generate_report") {
          assertReportOperationMatchesInterview(interview, claimed.operation);
          const acceptedInterview = refreshReportRetryActivity(
            interview,
            requiredDate(claimed.operation.lastAttemptAt, "report retry attempt time"),
          );
          await repositories.interviews.save({
            previous: interview,
            current: acceptedInterview,
            events: [],
          });
          return {
            kind: "report",
            execution: {
              claimed,
              retryCommand,
            },
          };
        }

        const acceptedAt = requiredDate(claimed.operation.lastAttemptAt, "retry attempt time");
        const acceptedInterview =
          target.status === "failed"
            ? retryInterviewOperation(
                interview,
                decodePlannedCommand(claimed.operation),
                acceptedAt,
              ).interview
            : refreshInterviewOperation(interview, claimed.operation.id, acceptedAt);
        await repositories.interviews.save({
          previous: interview,
          current: acceptedInterview,
          events: [],
        });
        return {
          kind: "model",
          execution: {
            claimed,
            plan: reconstructPlan(acceptedInterview, claimed.operation),
            retryCommand,
          },
        };
      });
    } catch (error) {
      if (!isRetryCommandRejection(error)) {
        throw error;
      }
      return {
        kind: "canonical",
        operation: await this.failRetryCommand(canonicalRetry, error),
      };
    }
  }

  private failRetryCommand(
    retryOperation: StoredOperation,
    error:
      | InterviewDomainError
      | InterviewVersionConflictError
      | OperationRunnerError
      | RepositoryInterviewUnavailableError
      | RepositoryNotFoundError
      | RepositoryOperationRetryConflictError,
  ): Promise<StoredOperation> {
    const classification =
      error instanceof InterviewVersionConflictError ? "version_conflict" : "command_rejected";
    return this.unitOfWork.run(async (repositories) => {
      const operation = requiredOperation(
        await repositories.operations.findById(retryOperation.id, retryOperation.accountId),
        retryOperation.id,
      );
      if (operation.status === "succeeded" || operation.status === "failed") {
        return operation;
      }
      let claimed: ClaimedOperation | null;
      if (operation.status === "pending") {
        try {
          claimed = await repositories.operations.claimPending(this.claimInput(operation));
        } catch (error) {
          if (error instanceof RepositoryInterviewUnavailableError) {
            return repositories.operations.failPendingRetryCommand({
              operationId: operation.id,
              accountId: operation.accountId,
              error: operationFailure("Retry command was rejected", false, classification),
            });
          }
          throw error;
        }
      } else {
        try {
          claimed = await repositories.operations.reclaimStaleProcessing({
            ...this.claimInput(operation),
            input: operation.input,
          });
        } catch (error) {
          if (error instanceof RepositoryOperationRetryConflictError) {
            return operation;
          }
          throw error;
        }
      }
      if (claimed === null) {
        return requiredOperation(
          await repositories.operations.findById(operation.id, operation.accountId),
          operation.id,
        );
      }
      return repositories.operations.completeFailure({
        ...completionLease(claimed),
        operationId: operation.id,
        accountId: operation.accountId,
        error: operationFailure("Retry command was rejected", false, classification),
        retryable: false,
      });
    });
  }

  private claimInput(operation: StoredOperation, leaseExpiresAt?: Date) {
    return operationClaimInput(operation, this.leaseOwner, this.leaseDurationMs, leaseExpiresAt);
  }
}

function isRetryCommandRejection(
  error: unknown,
): error is
  | InterviewDomainError
  | InterviewVersionConflictError
  | OperationRunnerError
  | RepositoryInterviewUnavailableError
  | RepositoryNotFoundError
  | RepositoryOperationRetryConflictError {
  return (
    error instanceof InterviewDomainError ||
    error instanceof InterviewVersionConflictError ||
    error instanceof OperationRunnerError ||
    error instanceof RepositoryInterviewUnavailableError ||
    error instanceof RepositoryNotFoundError ||
    error instanceof RepositoryOperationRetryConflictError
  );
}
