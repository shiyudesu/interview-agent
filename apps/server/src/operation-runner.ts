import { createHash } from "node:crypto";
import {
  type ClaimedOperation,
  type CreateOperation,
  InterviewCreationService,
  type JsonObject,
  type PgRepositoryUnitOfWork,
  RepositoryIdempotencyConflictError,
  RepositoryInterviewUnavailableError,
  RepositoryNotFoundError,
  RepositoryOperationRetryConflictError,
  type StoredOperation,
} from "@interview-agent/db";
import {
  type AbandonInterviewCommand,
  type AccountId,
  type AnswerEvaluationModel,
  type AnswerEvaluationResult,
  type AnswerMaterialId,
  aggregateCompleteInterviewScore,
  aggregateDomainScores,
  type ContinueInterviewCommand,
  cancelInterviewOperation,
  completeInterviewOperation,
  getCurrentQuestion,
  handleInterviewCommand,
  type ImmutableReportSnapshot,
  type Interview,
  type InterviewCommandResult,
  InterviewDomainError,
  type InterviewerTextModel,
  type InterviewId,
  type InterviewOperationPlan,
  InterviewVersionConflictError,
  KNOWLEDGE_DOMAINS,
  type MarkQuestionUnknownCommand,
  type ModelCallMetadata,
  type OperationId,
  parseAnswerMaterialId,
  parseEvaluationId,
  parseImmutableReportSnapshot,
  parseMessageId,
  parseOperationId,
  parseReportId,
  type ReportAnalysisModel,
  type ReportAnalysisRequest,
  type ReportAnalysisResult,
  type ReportId,
  type ReportKind,
  type ReportQuestionInput,
  type RequestQuestionClarificationCommand,
  refreshInterviewOperation,
  refreshReportRetryActivity,
  retryInterviewOperation,
  type SkipQuestionCommand,
  type SubmitAnswerCommand,
  type SubmitSupplementCommand,
} from "@interview-agent/domain";

import {
  AnswerEvaluationModelError,
  type AnswerEvaluationModelErrorCode,
} from "./answer-evaluation-model.js";
import {
  InterviewerTextModelError,
  type InterviewerTextModelErrorCode,
} from "./interviewer-text-model.js";
import type { OperationEventPublisher } from "./operation-events.js";
import { ReportAnalysisModelError } from "./report-analysis-model.js";

export const INTERVIEW_COMMAND_IDEMPOTENCY_SCOPE = "interview-command";
export const REPORT_GENERATION_IDEMPOTENCY_SCOPE = "report-generation";
const DEFAULT_OPERATION_LEASE_MS = 5 * 60 * 1_000;

export interface OperationCommandInput {
  readonly accountId: AccountId;
  readonly interviewId: InterviewId;
  readonly operationId: OperationId;
  readonly idempotencyKey: string;
  readonly expectedVersion: number;
  readonly occurredAt: Date;
}

export interface CreateInterviewOperationInput extends OperationCommandInput {
  readonly questionCount: 5 | 10 | 15;
}

export interface TextInterviewOperationInput extends OperationCommandInput {
  readonly text: string;
}

export interface RetryInterviewOperationInput {
  readonly accountId: AccountId;
  readonly interviewId: InterviewId;
  readonly operationId: OperationId;
  readonly targetOperationId: OperationId;
  readonly idempotencyKey: string;
  readonly expectedVersion: number;
  readonly occurredAt: Date;
}

export interface OperationRunnerOptions {
  readonly leaseOwner: string;
  readonly leaseDurationMs?: number;
  readonly now?: () => Date;
  readonly events?: OperationEventPublisher;
}

export interface OperationExecution {
  execute(operation: () => Promise<StoredOperation>): Promise<StoredOperation>;
}

export class ServerOwnedOperationExecution implements OperationExecution {
  execute(operation: () => Promise<StoredOperation>): Promise<StoredOperation> {
    return operation();
  }
}

export interface AcceptedOperationWork {
  readonly operationId: OperationId;
  start(): Promise<StoredOperation>;
}

export interface AcceptedOperationExecution {
  readonly operation: StoredOperation;
  readonly work: AcceptedOperationWork | null;
}

export interface OperationExecutionStarter {
  start(work: AcceptedOperationWork): void;
}

export class ServerOwnedOperationStarter implements OperationExecutionStarter {
  constructor(private readonly onFailure: (operationId: OperationId) => void = () => undefined) {}

  start(work: AcceptedOperationWork): void {
    let execution: Promise<StoredOperation>;
    try {
      execution = work.start();
    } catch {
      this.reportFailure(work.operationId);
      return;
    }
    void execution.catch(() => this.reportFailure(work.operationId));
  }

  private reportFailure(operationId: OperationId): void {
    try {
      this.onFailure(operationId);
    } catch {
      return;
    }
  }
}

type ProgressOperationType = Exclude<
  CreateOperation["type"],
  "create_interview" | "retry_operation" | "generate_report"
>;

export interface ProgressCommandRequest {
  readonly type: ProgressOperationType;
  readonly accountId: AccountId;
  readonly interviewId: InterviewId;
  readonly operationId: OperationId;
  readonly idempotencyKey: string;
  readonly expectedVersion: number;
  readonly occurredAt: Date;
  readonly text?: string;
}

interface ClaimedModelOperation {
  readonly claimed: ClaimedOperation;
  readonly plan: InterviewOperationPlan;
  readonly retryCommand?: ClaimedOperation;
}

interface ClaimedReportOperation {
  readonly claimed: ClaimedOperation;
  readonly retryCommand?: ClaimedOperation;
}

type PreparedOperation =
  | { readonly kind: "canonical"; readonly operation: StoredOperation }
  | { readonly kind: "model"; readonly execution: ClaimedModelOperation }
  | { readonly kind: "report"; readonly execution: ClaimedReportOperation };

type ModelCompletion =
  | {
      readonly kind: "clarification";
      readonly text: string;
      readonly metadata: ModelCallMetadata;
    }
  | {
      readonly kind: "follow_up";
      readonly evaluation: AnswerEvaluationResult;
      readonly text: string;
      readonly metadata: ModelCallMetadata;
    }
  | {
      readonly kind: "evaluation";
      readonly evaluation: AnswerEvaluationResult;
    };

type OperationFailure = JsonObject & {
  readonly code: "operation_failed" | "model_failure";
  readonly message: string;
  readonly retryable: boolean;
  readonly classification?: "command_rejected" | "version_conflict";
};

export class OperationRunner {
  private readonly creationService: InterviewCreationService;
  private readonly leaseDurationMs: number;
  private readonly now: () => Date;
  readonly events: OperationEventPublisher;

  constructor(
    private readonly unitOfWork: PgRepositoryUnitOfWork,
    private readonly interviewer: InterviewerTextModel,
    private readonly evaluator: AnswerEvaluationModel,
    private readonly reportAnalyzer: ReportAnalysisModel,
    private readonly options: OperationRunnerOptions,
  ) {
    this.creationService = new InterviewCreationService(unitOfWork);
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_OPERATION_LEASE_MS;
    this.now = options.now ?? (() => new Date());
    this.events = options.events ?? NO_OPERATION_EVENTS;
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

  async run(request: ProgressCommandRequest): Promise<StoredOperation> {
    return this.executeAccepted(await this.accept(request));
  }

  async accept(request: ProgressCommandRequest): Promise<AcceptedOperationExecution> {
    const prepared = await this.prepare(request);
    return this.acceptPrepared(prepared);
  }

  async retry(input: RetryInterviewOperationInput): Promise<StoredOperation> {
    return this.executeAccepted(await this.acceptRetry(input));
  }

  async acceptRetry(input: RetryInterviewOperationInput): Promise<AcceptedOperationExecution> {
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
      return canonicalExecution(retryOperation.operation);
    }

    let prepared: PreparedOperation;
    try {
      prepared = await this.unitOfWork.run(async (repositories) => {
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
      return canonicalExecution(await this.failRetryCommand(canonicalRetry, error));
    }
    return this.acceptPrepared(prepared);
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

  private async prepare(request: ProgressCommandRequest): Promise<PreparedOperation> {
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
      const createInput = progressOperationInput(request, questionPosition);
      const created = await repositories.operations.createOrLoad({
        id: request.operationId,
        accountId: request.accountId,
        interviewId: request.interviewId,
        idempotencyScope: INTERVIEW_COMMAND_IDEMPOTENCY_SCOPE,
        type: request.type,
        idempotencyKey: request.idempotencyKey,
        expectedVersion: request.expectedVersion,
        input: createInput,
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

  private executeAccepted(accepted: AcceptedOperationExecution): Promise<StoredOperation> {
    return accepted.work?.start() ?? Promise.resolve(accepted.operation);
  }

  private async executeModelOperation(execution: ClaimedModelOperation): Promise<StoredOperation> {
    publishOperationEvent(() => this.events.beginAttempt(execution.claimed.operation));
    let completion: ModelCompletion;
    try {
      completion = await this.callModels(execution.plan);
    } catch (error) {
      const failure = classifyModelFailure(error);
      if (failure === null) {
        throw error;
      }
      return this.failModelOperation(execution, failure);
    }
    return this.completeModelOperation(execution, completion);
  }

  private async callModels(plan: InterviewOperationPlan): Promise<ModelCompletion> {
    const question = getCurrentQuestion(plan.interview);
    if (plan.operation === "question_clarification") {
      const completed = await collectInterviewerText(
        this.interviewer.stream({ purpose: "clarify_question", question }),
      );
      return {
        kind: "clarification",
        text: completed.text,
        metadata: completed.metadata,
      };
    }

    const questionState = requiredQuestionState(plan.interview, plan.questionPosition);
    const answerMaterial = [...questionState.answerMaterial, plan.material];
    const evaluation = await this.evaluator.evaluate({
      question,
      answerMaterial,
      usedFollowUpGoalIds: new Set(
        questionState.systemFollowUps.map((followUp) => followUp.goalId),
      ),
    });
    if (evaluation.recommendedFollowUpGoal === null) {
      return { kind: "evaluation", evaluation };
    }

    const goal = question.followUpGoals.find(
      (candidate) => candidate.id === evaluation.recommendedFollowUpGoal?.goalId,
    );
    if (goal === undefined) {
      throw new OperationRunnerError("Evaluation selected an unknown follow-up goal");
    }
    const completed = await collectInterviewerText(
      this.interviewer.stream({
        purpose: "phrase_follow_up",
        question,
        goal,
        followUpPurpose: evaluation.recommendedFollowUpGoal.purpose,
        answerMaterial,
      }),
    );
    return {
      kind: "follow_up",
      evaluation,
      text: completed.text,
      metadata: completed.metadata,
    };
  }

  private async completeModelOperation(
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

  private async failModelOperation(
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

  private async executeReportOperation(
    execution: ClaimedReportOperation,
  ): Promise<StoredOperation> {
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
      return this.failReportOperation(execution, failure);
    }

    let analysis: ReportAnalysisResult;
    try {
      analysis = await this.reportAnalyzer.analyze(request);
    } catch (error) {
      const failure = classifyReportFailure(error);
      if (failure === null) {
        throw error;
      }
      return this.failReportOperation(execution, failure);
    }

    try {
      return await this.completeReportOperation(execution, analysis);
    } catch (error) {
      const failure = classifyReportFailure(error);
      if (failure === null) {
        throw error;
      }
      return this.failReportOperation(execution, failure);
    }
  }

  private async completeReportOperation(
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

  private async failReportOperation(
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

  private claimInput(operation: StoredOperation, leaseExpiresAt?: Date) {
    return {
      operationId: operation.id,
      accountId: operation.accountId,
      leaseOwner: this.options.leaseOwner,
      leaseDurationMs: this.leaseDurationMs,
      ...(leaseExpiresAt === undefined ? {} : { leaseExpiresAt }),
    };
  }
}

export class InterviewOperationHandlers {
  constructor(
    private readonly runner: OperationRunner,
    private readonly execution: OperationExecution = new ServerOwnedOperationExecution(),
  ) {}

  createInterview(input: CreateInterviewOperationInput): Promise<StoredOperation> {
    return this.execute(() => this.runner.createInterview(input));
  }

  async acceptCreateInterview(
    input: CreateInterviewOperationInput,
  ): Promise<AcceptedOperationExecution> {
    return canonicalExecution(await this.runner.createInterview(input));
  }

  submitAnswer(input: TextInterviewOperationInput): Promise<StoredOperation> {
    return this.progress("submit_answer", input);
  }

  acceptSubmitAnswer(input: TextInterviewOperationInput): Promise<AcceptedOperationExecution> {
    return this.acceptProgress("submit_answer", input);
  }

  submitSupplement(input: TextInterviewOperationInput): Promise<StoredOperation> {
    return this.progress("submit_supplement", input);
  }

  acceptSubmitSupplement(input: TextInterviewOperationInput): Promise<AcceptedOperationExecution> {
    return this.acceptProgress("submit_supplement", input);
  }

  requestQuestionClarification(input: OperationCommandInput): Promise<StoredOperation> {
    return this.progress("request_question_clarification", input);
  }

  acceptQuestionClarification(input: OperationCommandInput): Promise<AcceptedOperationExecution> {
    return this.acceptProgress("request_question_clarification", input);
  }

  markUnknown(input: OperationCommandInput): Promise<StoredOperation> {
    return this.progress("mark_question_unknown", input);
  }

  acceptMarkUnknown(input: OperationCommandInput): Promise<AcceptedOperationExecution> {
    return this.acceptProgress("mark_question_unknown", input);
  }

  skip(input: OperationCommandInput): Promise<StoredOperation> {
    return this.progress("skip_question", input);
  }

  acceptSkip(input: OperationCommandInput): Promise<AcceptedOperationExecution> {
    return this.acceptProgress("skip_question", input);
  }

  continueInterview(input: OperationCommandInput): Promise<StoredOperation> {
    return this.progress("continue_interview", input);
  }

  acceptContinueInterview(input: OperationCommandInput): Promise<AcceptedOperationExecution> {
    return this.acceptProgress("continue_interview", input);
  }

  endEarly(input: OperationCommandInput): Promise<StoredOperation> {
    return this.progress("end_interview_early", input);
  }

  acceptEndEarly(input: OperationCommandInput): Promise<AcceptedOperationExecution> {
    return this.acceptProgress("end_interview_early", input);
  }

  abandon(input: OperationCommandInput): Promise<StoredOperation> {
    return this.progress("abandon_interview", input);
  }

  acceptAbandon(input: OperationCommandInput): Promise<AcceptedOperationExecution> {
    return this.acceptProgress("abandon_interview", input);
  }

  retry(input: RetryInterviewOperationInput): Promise<StoredOperation> {
    return this.execute(() => this.runner.retry(input));
  }

  acceptRetry(input: RetryInterviewOperationInput): Promise<AcceptedOperationExecution> {
    return this.runner.acceptRetry(input);
  }

  private progress(
    type: ProgressOperationType,
    input: OperationCommandInput | TextInterviewOperationInput,
  ): Promise<StoredOperation> {
    return this.execute(() =>
      this.runner.run({
        type,
        ...input,
        ...("text" in input ? { text: input.text } : {}),
      }),
    );
  }

  private execute(operation: () => Promise<StoredOperation>): Promise<StoredOperation> {
    return this.execution.execute(operation);
  }

  private acceptProgress(
    type: ProgressOperationType,
    input: OperationCommandInput | TextInterviewOperationInput,
  ): Promise<AcceptedOperationExecution> {
    return this.runner.accept({
      type,
      ...input,
      ...("text" in input ? { text: input.text } : {}),
    });
  }
}

export class OperationRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationRunnerError";
  }
}

const NO_OPERATION_EVENTS: OperationEventPublisher = {
  beginAttempt: () => undefined,
  publishTextDelta: () => null,
  publishTextAndTerminal: () => null,
  publishTerminal: () => null,
};

function publishOperationEvent(publish: () => unknown): void {
  try {
    publish();
  } catch {
    return;
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

function decodeInitialCommand(
  operation: StoredOperation,
):
  | SubmitAnswerCommand
  | SubmitSupplementCommand
  | RequestQuestionClarificationCommand
  | MarkQuestionUnknownCommand
  | SkipQuestionCommand
  | ContinueInterviewCommand
  | AbandonInterviewCommand
  | import("@interview-agent/domain").EndInterviewEarlyCommand {
  const base = commandBase(operation);
  switch (operation.type) {
    case "submit_answer":
      return {
        ...base,
        type: operation.type,
        answerMaterialId: answerMaterialId(operation.id),
        text: readText(operation.input, operation.id),
      };
    case "submit_supplement":
      return {
        ...base,
        type: operation.type,
        answerMaterialId: answerMaterialId(operation.id),
        text: readText(operation.input, operation.id),
      };
    case "request_question_clarification":
    case "mark_question_unknown":
    case "skip_question":
    case "continue_interview":
    case "end_interview_early":
    case "abandon_interview":
      return { ...base, type: operation.type };
    default:
      throw new OperationRunnerError(`Operation ${operation.id} is not an interview command`);
  }
}

function decodePlannedCommand(
  operation: StoredOperation,
): SubmitAnswerCommand | SubmitSupplementCommand | RequestQuestionClarificationCommand {
  const command = decodeInitialCommand(operation);
  if (
    command.type !== "submit_answer" &&
    command.type !== "submit_supplement" &&
    command.type !== "request_question_clarification"
  ) {
    throw new RepositoryOperationRetryConflictError(operation.id);
  }
  return command;
}

function reconstructPlan(interview: Interview, operation: StoredOperation): InterviewOperationPlan {
  const pending = interview.pendingOperation;
  if (pending === null || pending.operationId !== operation.id) {
    throw new OperationRunnerError(`Interview ${interview.id} has no matching pending Operation`);
  }
  const command = decodePlannedCommand(operation);
  if (pending.operation === "question_clarification") {
    if (command.type !== "request_question_clarification") {
      throw new OperationRunnerError("Pending clarification Operation has the wrong command type");
    }
    return {
      kind: "operation_plan",
      operation: "question_clarification",
      interviewId: interview.id,
      operationId: operation.id,
      questionPosition: pending.questionPosition,
      acceptedAt: pending.acceptedAt,
      interview,
      command,
    };
  }
  if (command.type === "request_question_clarification") {
    throw new OperationRunnerError("Pending answer Operation has the wrong command type");
  }
  return {
    kind: "operation_plan",
    operation: "answer_analysis",
    interviewId: interview.id,
    operationId: operation.id,
    questionPosition: pending.questionPosition,
    acceptedAt: pending.acceptedAt,
    interview,
    command,
    material: {
      id: answerMaterialId(operation.id),
      kind:
        command.type === "submit_supplement"
          ? "supplement"
          : hasUnansweredFollowUp(interview, pending.questionPosition)
            ? "follow_up_answer"
            : "main_answer",
      text: command.text,
      submittedAt: operation.createdAt,
    },
  };
}

function completionCommand(
  operation: StoredOperation,
  interview: Interview,
  completion: ModelCompletion,
  occurredAt: Date,
) {
  const base = {
    interviewId: interview.id,
    operationId: operation.id,
    expectedVersion: interview.version,
    occurredAt,
  };
  if (completion.kind === "clarification") {
    return {
      ...base,
      type: "record_question_clarification" as const,
      messageId: parseMessageId(derivedIdentifier("message", operation.id)),
      text: completion.text,
    };
  }
  if (completion.kind === "follow_up") {
    const recommendation = completion.evaluation.recommendedFollowUpGoal;
    if (recommendation === null) {
      throw new OperationRunnerError("Follow-up completion is missing its selected goal");
    }
    return {
      ...base,
      type: "record_system_follow_up" as const,
      messageId: parseMessageId(derivedIdentifier("message", operation.id)),
      goalId: recommendation.goalId,
      kind: recommendation.kind,
      purpose: recommendation.purpose,
      responseClassification: completion.evaluation.classification,
      text: completion.text,
    };
  }
  return {
    ...base,
    type: "record_question_evaluation" as const,
    evaluation: {
      id: parseEvaluationId(derivedIdentifier("evaluation", operation.id)),
      classification: completion.evaluation.classification,
      rubricItems: completion.evaluation.rubricItems,
    },
  };
}

function progressOperationInput(
  request: ProgressCommandRequest,
  questionPosition: number,
): JsonObject {
  return {
    questionPosition,
    ...(request.text === undefined ? {} : { text: request.text }),
  };
}

function creationOperationInput(interview: Interview): JsonObject {
  return {
    questionCount: interview.questionCount,
    selectionSeed: interview.blueprint.selectionSeed,
    questions: interview.blueprint.questions.map(({ position, question }) => ({
      position,
      questionId: String(question.questionId),
      questionVersion: question.questionVersion,
    })),
  };
}

function reportOperationInput(reportKind: ReportKind, requestedAt: Date): JsonObject {
  return {
    reportKind,
    reportRequestedAt: requestedAt.toISOString(),
  };
}

function assertExistingCreationMatches(
  existing: StoredOperation,
  input: CreateInterviewOperationInput,
): void {
  if (
    existing.type !== "create_interview" ||
    existing.expectedVersion !== input.expectedVersion ||
    existing.input["questionCount"] !== input.questionCount
  ) {
    throw new RepositoryIdempotencyConflictError(
      existing.idempotencyScope,
      existing.idempotencyKey,
    );
  }
}

function commandBase(operation: StoredOperation) {
  readQuestionPosition(operation.input, operation.id);
  return {
    interviewId: operation.interviewId,
    operationId: operation.id,
    expectedVersion: operation.expectedVersion,
    occurredAt: operation.createdAt,
  };
}

function operationResult(
  interview: Interview,
  reportOperationId: OperationId | null = null,
): JsonObject {
  return {
    interviewId: String(interview.id),
    interviewVersion: interview.version,
    reportId: interview.reportId === null ? null : String(interview.reportId),
    ...(reportOperationId === null ? {} : { reportOperationId: String(reportOperationId) }),
  };
}

function creationOperationResult(operation: StoredOperation): JsonObject {
  if (operation.type !== "create_interview" || operation.input["questionCount"] === undefined) {
    throw new OperationRunnerError(`Operation ${operation.id} has invalid creation input`);
  }
  return {
    interviewId: String(operation.interviewId),
    interviewVersion: 1,
    reportId: null,
  };
}

function retryOperationResult(target: StoredOperation, interview: Interview): JsonObject {
  return {
    ...operationResult(interview),
    targetOperationId: String(target.id),
    targetOperationStatus: target.status,
  };
}

function linkedReportOperationId(operation: StoredOperation): OperationId | null {
  const value = operation.result?.["reportOperationId"];
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new OperationRunnerError(`Operation ${operation.id} has an invalid report link`);
  }
  return parseOperationId(value);
}

function reportOperationIdFor(operationId: OperationId): OperationId {
  return parseOperationId(derivedIdentifier("report-operation", operationId));
}

function reportIdFor(operationId: OperationId): ReportId {
  return parseReportId(derivedIdentifier("report", operationId));
}

function requiredReportKind(operation: StoredOperation): ReportKind {
  const value = operation.input["reportKind"];
  if (value !== "complete" && value !== "incomplete") {
    throw new OperationRunnerError(`Operation ${operation.id} has an invalid report kind`);
  }
  return value;
}

function assertReportOperationMatchesInterview(
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

function createReportAnalysisRequest(interview: Interview): ReportAnalysisRequest {
  if (interview.status !== "report_pending" || interview.pendingReportKind === null) {
    throw new OperationRunnerError(`Interview ${interview.id} is not awaiting a report`);
  }
  const selectedQuestions = interview.questions.filter((question) => question.outcome !== null);
  if (
    selectedQuestions.length === 0 ||
    (interview.pendingReportKind === "complete" &&
      selectedQuestions.length !== interview.questionCount)
  ) {
    throw new OperationRunnerError(`Interview ${interview.id} has invalid report coverage`);
  }

  const questions: ReportQuestionInput[] = selectedQuestions.map((questionState) => {
    const question = requiredBlueprintQuestion(interview, questionState.position);
    const outcome = questionState.outcome;
    if (outcome === null) {
      throw new OperationRunnerError(`Interview ${interview.id} report question has no outcome`);
    }
    if (questionState.evaluation === null) {
      if (outcome.kind !== "unknown" && outcome.kind !== "skipped") {
        throw new OperationRunnerError(
          `Interview ${interview.id} report question has no structured evaluation`,
        );
      }
      return {
        question,
        answerMaterial: [],
        evaluation: null,
        outcome,
      };
    }
    return {
      question,
      answerMaterial: questionState.answerMaterial,
      evaluation: questionState.evaluation,
    };
  });
  const assessedDomains = KNOWLEDGE_DOMAINS.filter((domain) =>
    questions.some((question) => question.question.domain === domain),
  );
  return {
    reportKind: interview.pendingReportKind,
    questions,
    assessedDomains,
  };
}

function createReportPersistence(
  interview: Interview,
  reportKind: ReportKind,
  reportId: ReportId,
  createdAt: Date,
  analysis: ReportAnalysisResult,
) {
  const request = createReportAnalysisRequest(interview);
  if (
    request.reportKind !== reportKind ||
    analysis.perQuestion.length !== request.questions.length
  ) {
    throw new OperationRunnerError("Report analysis coverage does not match the interview");
  }

  const selectedQuestionStates = interview.questions.filter(
    (question) => question.outcome !== null,
  );
  const reportQuestions = selectedQuestionStates.map((questionState, index) => {
    const questionAnalysis = analysis.perQuestion[index];
    if (questionAnalysis === undefined) {
      throw new OperationRunnerError("Report analysis is missing question feedback");
    }
    return createReportQuestionFeedback(interview, questionState, questionAnalysis);
  });
  const selectedScores = selectedQuestionStates.map((questionState) => {
    const outcome = questionState.outcome;
    if (outcome === null) {
      throw new OperationRunnerError("Report question has no deterministic outcome");
    }
    return {
      domain: requiredBlueprintQuestion(interview, questionState.position).domain,
      outcome,
    };
  });
  const domains = aggregateDomainScores(selectedScores);
  const common = {
    reportId,
    interviewId: interview.id,
    accountId: interview.accountId,
    generatedAt: createdAt.toISOString(),
    overallExplanation: analysis.overallExplanation,
    strengths: analysis.strengths,
    weaknesses: analysis.weaknesses,
    priorities: analysis.priorities,
    learningSuggestions: analysis.learningSuggestions,
    schemaVersion: analysis.metadata.schemaVersion,
    modelMetadata: {
      provider: analysis.metadata.provider,
      modelId: analysis.metadata.modelId,
      promptVersion: analysis.metadata.promptVersion,
      schemaVersion: analysis.metadata.schemaVersion,
      questionVersion: analysis.metadata.questionVersion,
      purpose: analysis.metadata.purpose,
      latencyMs: analysis.metadata.latencyMs,
      tokens: {
        inputTokens: analysis.metadata.inputTokens,
        outputTokens: analysis.metadata.outputTokens,
      },
    },
    questionVersions: reportQuestions.map((question) => ({
      questionId: question.questionId,
      questionVersion: question.questionVersion,
    })),
    domains,
    questions: reportQuestions,
  };
  const snapshotValue =
    reportKind === "complete"
      ? {
          kind: "complete" as const,
          ...common,
          overallScore: aggregateCompleteInterviewScore(selectedScores, interview.questionCount)
            .overallScore,
        }
      : {
          kind: "incomplete" as const,
          ...common,
        };
  let snapshot: ImmutableReportSnapshot;
  try {
    snapshot = parseImmutableReportSnapshot(snapshotValue);
  } catch {
    throw new OperationRunnerError("Generated report snapshot is invalid");
  }
  return {
    id: reportId,
    kind: reportKind,
    schemaVersion: snapshot.schemaVersion,
    snapshot,
    modelMetadata: analysis.metadata,
    createdAt,
  };
}

function createReportQuestionFeedback(
  interview: Interview,
  questionState: Interview["questions"][number],
  analysis: ReportAnalysisResult["perQuestion"][number],
): ImmutableReportSnapshot["questions"][number] {
  const question = requiredBlueprintQuestion(interview, questionState.position);
  const outcome = questionState.outcome;
  if (outcome === null || analysis.questionId !== question.questionId) {
    throw new OperationRunnerError("Report question analysis order is invalid");
  }
  const questionReference = {
    source: "question_snapshot" as const,
    questionId: question.questionId,
  };
  const evaluationEvidenceIds = new Set(
    questionState.evaluation?.rubricItems.flatMap((item) => item.evidenceMaterialIds) ?? [],
  );
  const analysisEvidence = analysis.evidenceMaterialIds
    .filter((id) => evaluationEvidenceIds.has(id))
    .map((answerMaterialId) => ({
      source: "answer_material" as const,
      answerMaterialId,
    }));
  const matchedKnowledgePoints =
    questionState.evaluation?.rubricItems
      .filter((item) => item.awardedPoints > 0)
      .map((item) => ({
        rubricItemId: item.rubricItemId,
        summary: "回答中已体现该知识点。",
        awardedPoints: item.awardedPoints,
        evidence: item.evidenceMaterialIds.map((answerMaterialId) => ({
          source: "answer_material" as const,
          answerMaterialId,
        })),
      })) ?? [];
  const missingOrIncorrectPoints =
    questionState.evaluation === null
      ? [
          {
            rubricItemId: requiredRubricItemId(question, interview.id),
            summary:
              outcome.kind === "unknown"
                ? "该题涉及的知识点尚未掌握。"
                : "该题涉及的知识点尚未作答。",
            evidence: [questionReference],
          },
        ]
      : questionState.evaluation.rubricItems.flatMap((item) =>
          item.missingOrIncorrectPoints.map((summary) => ({
            rubricItemId: item.rubricItemId,
            summary,
            evidence: [questionReference],
          })),
        );
  const evidence = dedupeReportEvidence([
    questionReference,
    ...analysisEvidence,
    ...matchedKnowledgePoints.flatMap((point) => point.evidence),
  ]);
  const common = {
    questionId: question.questionId,
    questionVersion: question.questionVersion,
    domain: question.domain,
    position: questionState.position,
    displayedQuestion: question.displayedWording,
    answerSummary: analysis.answerSummary,
    matchedKnowledgePoints,
    missingOrIncorrectPoints,
    scoreRationale: analysis.scoreRationale,
    improvementSuggestions: analysis.improvementSuggestions,
    evidence,
  };
  return outcome.kind === "scored"
    ? {
        ...common,
        outcome: "scored",
        score: outcome.score,
      }
    : {
        ...common,
        outcome: outcome.kind,
        score: 0,
        zeroScoreReason: outcome.zeroScoreReason,
      };
}

function requiredBlueprintQuestion(interview: Interview, position: number) {
  const item = interview.blueprint.questions[position - 1];
  if (item === undefined || item.position !== position) {
    throw new OperationRunnerError(`Interview ${interview.id} question snapshot is unavailable`);
  }
  return item.question;
}

function requiredRubricItemId(
  question: Interview["blueprint"]["questions"][number]["question"],
  interviewId: InterviewId,
) {
  const rubricItem = question.rubric[0];
  if (rubricItem === undefined) {
    throw new OperationRunnerError(`Interview ${interviewId} question Rubric is unavailable`);
  }
  return rubricItem.id;
}

function dedupeReportEvidence(
  references: readonly ImmutableReportSnapshot["questions"][number]["evidence"][number][],
): readonly ImmutableReportSnapshot["questions"][number]["evidence"][number][] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key =
      reference.source === "answer_material"
        ? `answer:${reference.answerMaterialId}`
        : `question:${reference.questionId}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function operationFailure(
  message: string,
  retryable: boolean,
  classification?: OperationFailure["classification"],
): OperationFailure {
  return {
    code: "operation_failed",
    message: message.trim().length === 0 ? "Operation failed" : message,
    retryable,
    ...(classification === undefined ? {} : { classification }),
  };
}

function classifyModelFailure(error: unknown): OperationFailure | null {
  if (error instanceof AnswerEvaluationModelError) {
    return modelFailure(error.code, error.message);
  }
  if (error instanceof InterviewerTextModelError) {
    return modelFailure(error.code, error.message);
  }
  return null;
}

function classifyReportFailure(error: unknown): OperationFailure | null {
  if (error instanceof ReportAnalysisModelError) {
    return {
      code: "model_failure",
      message: "Report analysis failed",
      retryable: true,
    };
  }
  if (error instanceof OperationRunnerError) {
    return {
      code: "operation_failed",
      message: "Report generation failed",
      retryable: true,
    };
  }
  return null;
}

function modelFailure(
  code: AnswerEvaluationModelErrorCode | InterviewerTextModelErrorCode,
  message: string,
): OperationFailure {
  return {
    code: "model_failure",
    message,
    retryable: code !== "invalid_request",
  };
}

async function collectInterviewerText(
  events: AsyncIterable<import("@interview-agent/domain").InterviewerTextEvent>,
): Promise<{ readonly text: string; readonly metadata: ModelCallMetadata }> {
  let completed: { readonly text: string; readonly metadata: ModelCallMetadata } | null = null;
  for await (const event of events) {
    if (event.type === "completed") {
      completed = { text: event.text, metadata: event.metadata };
    }
  }
  if (completed === null) {
    throw new OperationRunnerError("Interviewer text stream completed without final text");
  }
  return completed;
}

function completionLease(claimed: ClaimedOperation) {
  return {
    leaseOwner: claimed.leaseOwner,
    leaseToken: claimed.leaseToken,
    attemptCount: claimed.attemptCount,
  };
}

function answerMaterialId(operationId: OperationId): AnswerMaterialId {
  return parseAnswerMaterialId(derivedIdentifier("answer", operationId));
}

function derivedIdentifier(kind: string, operationId: OperationId): string {
  const hash = createHash("sha256").update(`${kind}:${operationId}`).digest("hex");
  return `${kind}-${hash}`;
}

function readQuestionPosition(input: JsonObject, operationId: OperationId): number {
  const value = input["questionPosition"];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new OperationRunnerError(`Operation ${operationId} has an invalid question position`);
  }
  return value;
}

function readText(input: JsonObject, operationId: OperationId): string {
  const value = input["text"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OperationRunnerError(`Operation ${operationId} has invalid answer text`);
  }
  return value;
}

function requiredOperation(
  operation: StoredOperation | null,
  operationId: OperationId,
): StoredOperation {
  if (operation === null) {
    throw new RepositoryNotFoundError("Operation", operationId);
  }
  return operation;
}

function requiredInterview(interview: Interview | null, interviewId: InterviewId): Interview {
  if (interview === null) {
    throw new RepositoryNotFoundError("interview", interviewId);
  }
  return interview;
}

function requiredDate(value: Date | null, field: string): Date {
  if (value === null || !Number.isFinite(value.getTime())) {
    throw new OperationRunnerError(`Operation ${field} is unavailable`);
  }
  return value;
}

function requiredQuestionState(interview: Interview, position: number) {
  const question = interview.questions[position - 1];
  if (question === undefined || question.position !== position) {
    throw new OperationRunnerError(`Interview ${interview.id} question state is invalid`);
  }
  return question;
}

function hasUnansweredFollowUp(interview: Interview, position: number): boolean {
  const question = requiredQuestionState(interview, position);
  return (
    question.systemFollowUps.length >
    question.answerMaterial.filter((material) => material.kind === "follow_up_answer").length
  );
}

function notBefore(value: Date, minimum: Date): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new OperationRunnerError("Operation completion time is invalid");
  }
  return value.getTime() < minimum.getTime() ? new Date(minimum.getTime()) : value;
}

function isPostgresSerializationFailure(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return false;
    }
    const candidate = current as {
      readonly cause?: unknown;
      readonly code?: unknown;
    };
    if (candidate.code === "40001") {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}
