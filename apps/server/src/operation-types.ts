import type {
  ClaimedOperation,
  CreateOperation,
  JsonObject,
  StoredOperation,
} from "@interview-agent/db";
import type {
  AccountId,
  AnswerEvaluationResult,
  InterviewId,
  InterviewOperationPlan,
  ModelCallMetadata,
  OperationId,
} from "@interview-agent/domain";

import type { OperationEventPublisher } from "./operation-events.js";

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

export interface AcceptedOperationWork {
  readonly operationId: OperationId;
  start(): Promise<StoredOperation>;
}

export interface AcceptedOperationExecution {
  readonly operation: StoredOperation;
  readonly work: AcceptedOperationWork | null;
}

export type ProgressOperationType = Exclude<
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

export interface ClaimedModelOperation {
  readonly claimed: ClaimedOperation;
  readonly plan: InterviewOperationPlan;
  readonly retryCommand?: ClaimedOperation;
}

export interface ClaimedReportOperation {
  readonly claimed: ClaimedOperation;
  readonly retryCommand?: ClaimedOperation;
}

export type PreparedOperation =
  | { readonly kind: "canonical"; readonly operation: StoredOperation }
  | { readonly kind: "model"; readonly execution: ClaimedModelOperation }
  | { readonly kind: "report"; readonly execution: ClaimedReportOperation };

export type ModelCompletion =
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

export type OperationFailure = JsonObject & {
  readonly code: "operation_failed" | "model_failure";
  readonly message: string;
  readonly retryable: boolean;
  readonly classification?: "command_rejected" | "version_conflict";
};
