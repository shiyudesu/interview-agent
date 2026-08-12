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
  type ContinueInterviewCommand,
  cancelInterviewOperation,
  completeInterviewOperation,
  getCurrentQuestion,
  handleInterviewCommand,
  type Interview,
  type InterviewCommandResult,
  InterviewDomainError,
  type InterviewerTextModel,
  type InterviewId,
  type InterviewOperationPlan,
  InterviewVersionConflictError,
  type MarkQuestionUnknownCommand,
  type ModelCallMetadata,
  type OperationId,
  parseAnswerMaterialId,
  parseEvaluationId,
  parseMessageId,
  type RequestQuestionClarificationCommand,
  refreshInterviewOperation,
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

export const INTERVIEW_COMMAND_IDEMPOTENCY_SCOPE = "interview-command";
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
}

export interface OperationExecution {
  execute(operation: () => Promise<StoredOperation>): Promise<StoredOperation>;
}

export class ServerOwnedOperationExecution implements OperationExecution {
  execute(operation: () => Promise<StoredOperation>): Promise<StoredOperation> {
    return operation();
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

type PreparedOperation =
  | { readonly kind: "canonical"; readonly operation: StoredOperation }
  | { readonly kind: "model"; readonly execution: ClaimedModelOperation };

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
};

export class OperationRunner {
  private readonly creationService: InterviewCreationService;
  private readonly leaseDurationMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly unitOfWork: PgRepositoryUnitOfWork,
    private readonly interviewer: InterviewerTextModel,
    private readonly evaluator: AnswerEvaluationModel,
    private readonly options: OperationRunnerOptions,
  ) {
    this.creationService = new InterviewCreationService(unitOfWork);
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_OPERATION_LEASE_MS;
    this.now = options.now ?? (() => new Date());
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
    const prepared = await this.prepare(request);
    if (prepared.kind === "canonical") {
      return prepared.operation;
    }
    return this.executeModelOperation(prepared.execution);
  }

  async retry(input: RetryInterviewOperationInput): Promise<StoredOperation> {
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
      return retryOperation.operation;
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
            target.type !== "request_question_clarification")
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
      return this.failRetryCommand(canonicalRetry, error);
    }
    if (prepared.kind === "canonical") {
      return prepared.operation;
    }
    return this.executeModelOperation(prepared.execution);
  }

  private failRetryCommand(
    retryOperation: StoredOperation,
    _error:
      | InterviewDomainError
      | InterviewVersionConflictError
      | OperationRunnerError
      | RepositoryInterviewUnavailableError
      | RepositoryNotFoundError
      | RepositoryOperationRetryConflictError,
  ): Promise<StoredOperation> {
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
              error: operationFailure("Retry command was rejected", false),
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
        error: operationFailure("Retry command was rejected", false),
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
        return { kind: "canonical", operation: created.operation };
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
            error: operationFailure("Interview creation is still finalizing", false),
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
            error: operationFailure(error.message, false),
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

      const completed = await repositories.operations.completeSuccess({
        ...completionLease(claimed),
        operationId: claimed.operation.id,
        accountId: request.accountId,
        result: operationResult(result.interview),
      });
      await repositories.interviews.save({
        previous: currentInterview,
        current: result.interview,
        events: result.events,
      });
      return { kind: "canonical", operation: completed };
    });
  }

  private async executeModelOperation(execution: ClaimedModelOperation): Promise<StoredOperation> {
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
    return this.unitOfWork.run(async (repositories) => {
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
        return completedOperation;
      }
      const retryCommand = execution.retryCommand;
      return repositories.operations.completeSuccess({
        ...completionLease(retryCommand),
        operationId: retryCommand.operation.id,
        accountId: retryCommand.operation.accountId,
        result: retryOperationResult(completedOperation, transition.interview),
      });
    });
  }

  private async failModelOperation(
    execution: ClaimedModelOperation,
    failure: OperationFailure,
  ): Promise<StoredOperation> {
    const { claimed } = execution;
    return this.unitOfWork.run(async (repositories) => {
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
        return failed;
      }
      return repositories.operations.completeFailure({
        ...completionLease(retryCommand),
        operationId: retryCommand.operation.id,
        accountId: retryCommand.operation.accountId,
        error: { ...failure, retryable: false },
        retryable: false,
      });
    });
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
    return this.execution.execute(() => this.runner.createInterview(input));
  }

  submitAnswer(input: TextInterviewOperationInput): Promise<StoredOperation> {
    return this.progress("submit_answer", input);
  }

  submitSupplement(input: TextInterviewOperationInput): Promise<StoredOperation> {
    return this.progress("submit_supplement", input);
  }

  requestQuestionClarification(input: OperationCommandInput): Promise<StoredOperation> {
    return this.progress("request_question_clarification", input);
  }

  markUnknown(input: OperationCommandInput): Promise<StoredOperation> {
    return this.progress("mark_question_unknown", input);
  }

  skip(input: OperationCommandInput): Promise<StoredOperation> {
    return this.progress("skip_question", input);
  }

  continueInterview(input: OperationCommandInput): Promise<StoredOperation> {
    return this.progress("continue_interview", input);
  }

  endEarly(input: OperationCommandInput): Promise<StoredOperation> {
    return this.progress("end_interview_early", input);
  }

  abandon(input: OperationCommandInput): Promise<StoredOperation> {
    return this.progress("abandon_interview", input);
  }

  retry(input: RetryInterviewOperationInput): Promise<StoredOperation> {
    return this.execution.execute(() => this.runner.retry(input));
  }

  private progress(
    type: ProgressOperationType,
    input: OperationCommandInput | TextInterviewOperationInput,
  ): Promise<StoredOperation> {
    return this.execution.execute(() =>
      this.runner.run({
        type,
        ...input,
        ...("text" in input ? { text: input.text } : {}),
      }),
    );
  }
}

export class OperationRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationRunnerError";
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

function operationResult(interview: Interview): JsonObject {
  return {
    interviewId: String(interview.id),
    interviewVersion: interview.version,
    reportId: interview.reportId === null ? null : String(interview.reportId),
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

function operationFailure(message: string, retryable: boolean): OperationFailure {
  return {
    code: "operation_failed",
    message: message.trim().length === 0 ? "Operation failed" : message,
    retryable,
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
