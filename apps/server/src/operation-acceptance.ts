import {
  InterviewCreationService,
  type PgRepositoryUnitOfWork,
  RepositoryIdempotencyConflictError,
  type StoredOperation,
} from "@interview-agent/db";
import {
  handleInterviewCommand,
  type InterviewCommandResult,
  InterviewDomainError,
  InterviewVersionConflictError,
} from "@interview-agent/domain";

import {
  assertExistingCreationMatches,
  creationOperationInput,
  creationOperationResult,
  decodeInitialCommand,
  linkedReportOperationId,
  operationResult,
  progressOperationInput,
  readQuestionPosition,
} from "./operation-command-codec.js";
import { OperationRunnerError } from "./operation-errors.js";
import { operationFailure } from "./operation-failure.js";
import {
  isPostgresSerializationFailure,
  requiredInterview,
  requiredOperation,
} from "./operation-guards.js";
import { reportOperationIdFor } from "./operation-identity.js";
import { completionLease, operationClaimInput } from "./operation-lease.js";
import {
  INTERVIEW_COMMAND_IDEMPOTENCY_SCOPE,
  REPORT_GENERATION_IDEMPOTENCY_SCOPE,
} from "./operation-scopes.js";
import type {
  CreateInterviewOperationInput,
  PreparedOperation,
  ProgressCommandRequest,
} from "./operation-types.js";
import {
  assertReportOperationMatchesInterview,
  reportOperationInput,
} from "./report-operation-codec.js";

export class OperationAcceptanceService {
  private readonly creationService: InterviewCreationService;

  constructor(
    private readonly unitOfWork: PgRepositoryUnitOfWork,
    private readonly leaseOwner: string,
    private readonly leaseDurationMs: number,
  ) {
    this.creationService = new InterviewCreationService(unitOfWork);
  }

  async createInterview(input: CreateInterviewOperationInput): Promise<StoredOperation> {
    let prepared: StoredOperation | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        prepared = await this.unitOfWork.run(
          async (repositories) => {
            await repositories.operations.lockAccountForCreation(input.accountId);
            const existing = await repositories.operations.findByIdempotencyKey(
              input.accountId,
              INTERVIEW_COMMAND_IDEMPOTENCY_SCOPE,
              input.idempotencyKey,
            );
            if (existing !== null) {
              assertExistingCreationMatches(existing, input);
              return existing;
            }

            const transition = await this.creationService.createWithRepositories(repositories, {
              accountId: input.accountId,
              interviewId: input.interviewId,
              operationId: input.operationId,
              questionCount: input.questionCount,
              occurredAt: input.occurredAt,
              expectedVersion: input.expectedVersion,
            });
            const created = await repositories.operations.createOrLoad({
              id: input.operationId,
              accountId: input.accountId,
              interviewId: input.interviewId,
              idempotencyScope: INTERVIEW_COMMAND_IDEMPOTENCY_SCOPE,
              type: "create_interview",
              idempotencyKey: input.idempotencyKey,
              expectedVersion: input.expectedVersion,
              input: creationOperationInput(transition.interview),
              createdAt: input.occurredAt,
            });
            return created.operation;
          },
          { isolationLevel: "serializable", accessMode: "read write" },
        );
        break;
      } catch (error) {
        if (attempt === 2 || !isPostgresSerializationFailure(error)) {
          throw error;
        }
      }
    }
    if (prepared === undefined) {
      throw new OperationRunnerError("Interview creation preparation did not complete");
    }
    if (prepared.status !== "pending") {
      return prepared;
    }
    return this.unitOfWork.run(async (repositories) => {
      const operation = requiredOperation(
        await repositories.operations.findById(prepared.id, input.accountId),
        prepared.id,
      );
      if (operation.status !== "pending") {
        return operation;
      }
      const claimed = await repositories.operations.claimPending(this.claimInput(operation));
      if (claimed === null) {
        return requiredOperation(
          await repositories.operations.findById(operation.id, input.accountId),
          operation.id,
        );
      }
      return repositories.operations.completeSuccess({
        ...completionLease(claimed),
        operationId: operation.id,
        accountId: input.accountId,
        result: creationOperationResult(operation),
      });
    });
  }

  acceptProgress(request: ProgressCommandRequest): Promise<PreparedOperation> {
    return this.unitOfWork.run(async (repositories) => {
      const existing = await repositories.operations.findByIdempotencyKey(
        request.accountId,
        INTERVIEW_COMMAND_IDEMPOTENCY_SCOPE,
        request.idempotencyKey,
      );
      const interview =
        existing === null
          ? requiredInterview(
              await repositories.interviews.findById(request.interviewId, request.accountId),
              request.interviewId,
            )
          : null;
      if (
        existing !== null &&
        (existing.interviewId !== request.interviewId ||
          existing.type !== request.type ||
          existing.expectedVersion !== request.expectedVersion)
      ) {
        throw new RepositoryIdempotencyConflictError(
          existing.idempotencyScope,
          existing.idempotencyKey,
        );
      }
      const questionPosition =
        existing === null
          ? interview?.currentQuestionPosition
          : readQuestionPosition(existing.input, existing.id);
      if (questionPosition === undefined) {
        throw new OperationRunnerError("Current question position is unavailable");
      }
      const created = await repositories.operations.createOrLoad({
        id: request.operationId,
        accountId: request.accountId,
        interviewId: request.interviewId,
        idempotencyScope: INTERVIEW_COMMAND_IDEMPOTENCY_SCOPE,
        type: request.type,
        idempotencyKey: request.idempotencyKey,
        expectedVersion: request.expectedVersion,
        input: progressOperationInput(request, questionPosition),
        createdAt: request.occurredAt,
      });
      if (created.operation.status !== "pending") {
        const linkedReportId = linkedReportOperationId(created.operation);
        return {
          kind: "canonical",
          operation:
            linkedReportId === null
              ? created.operation
              : requiredOperation(
                  await repositories.operations.findById(linkedReportId, request.accountId),
                  linkedReportId,
                ),
        };
      }
      const openCreation = await repositories.operations.findOpenCreationByInterview(
        request.interviewId,
        request.accountId,
      );
      if (openCreation !== null) {
        const blocked = await repositories.operations.claimPending(
          this.claimInput(created.operation),
        );
        if (blocked === null) {
          return {
            kind: "canonical",
            operation: requiredOperation(
              await repositories.operations.findById(created.operation.id, request.accountId),
              created.operation.id,
            ),
          };
        }
        return {
          kind: "canonical",
          operation: await repositories.operations.completeFailure({
            ...completionLease(blocked),
            operationId: blocked.operation.id,
            accountId: request.accountId,
            error: operationFailure(
              "Interview creation is still finalizing",
              false,
              "command_rejected",
            ),
            retryable: false,
          }),
        };
      }

      const claimed = await repositories.operations.claimPending(
        this.claimInput(created.operation),
      );
      if (claimed === null) {
        return {
          kind: "canonical",
          operation: requiredOperation(
            await repositories.operations.findById(created.operation.id, request.accountId),
            created.operation.id,
          ),
        };
      }
      const currentInterview = requiredInterview(
        await repositories.interviews.findById(request.interviewId, request.accountId),
        request.interviewId,
      );
      let result: InterviewCommandResult;
      try {
        result = handleInterviewCommand(currentInterview, decodeInitialCommand(claimed.operation));
      } catch (error) {
        if (!(error instanceof InterviewDomainError)) {
          throw error;
        }
        return {
          kind: "canonical",
          operation: await repositories.operations.completeFailure({
            ...completionLease(claimed),
            operationId: claimed.operation.id,
            accountId: request.accountId,
            error: operationFailure(
              error.message,
              false,
              error instanceof InterviewVersionConflictError
                ? "version_conflict"
                : "command_rejected",
            ),
            retryable: false,
          }),
        };
      }

      if (result.kind === "operation_plan") {
        await repositories.interviews.save({
          previous: currentInterview,
          current: result.interview,
          events: [],
        });
        return {
          kind: "model",
          execution: { claimed, plan: result },
        };
      }

      const reportRequest = result.events.find((event) => event.type === "report_requested");
      const reportOperationId =
        reportRequest === undefined ? null : reportOperationIdFor(claimed.operation.id);
      const completed = await repositories.operations.completeSuccess({
        ...completionLease(claimed),
        operationId: claimed.operation.id,
        accountId: request.accountId,
        result: operationResult(result.interview, reportOperationId),
      });
      await repositories.interviews.save({
        previous: currentInterview,
        current: result.interview,
        events: result.events,
      });
      if (reportRequest !== undefined && reportOperationId !== null) {
        const reportOperation = await repositories.operations.createOrLoad({
          id: reportOperationId,
          accountId: request.accountId,
          interviewId: request.interviewId,
          idempotencyScope: REPORT_GENERATION_IDEMPOTENCY_SCOPE,
          type: "generate_report",
          idempotencyKey: String(request.interviewId),
          expectedVersion: result.interview.version,
          input: reportOperationInput(reportRequest.reportKind, reportRequest.occurredAt),
          createdAt: reportRequest.occurredAt,
        });
        if (reportOperation.operation.status !== "pending") {
          return { kind: "canonical", operation: reportOperation.operation };
        }
        const reportClaim = await repositories.operations.claimPending(
          this.claimInput(reportOperation.operation),
        );
        if (reportClaim === null) {
          return {
            kind: "canonical",
            operation: requiredOperation(
              await repositories.operations.findById(reportOperationId, request.accountId),
              reportOperationId,
            ),
          };
        }
        assertReportOperationMatchesInterview(result.interview, reportClaim.operation);
        return {
          kind: "report",
          execution: { claimed: reportClaim },
        };
      }
      return { kind: "canonical", operation: completed };
    });
  }

  private claimInput(operation: StoredOperation, leaseExpiresAt?: Date) {
    return operationClaimInput(operation, this.leaseOwner, this.leaseDurationMs, leaseExpiresAt);
  }
}
