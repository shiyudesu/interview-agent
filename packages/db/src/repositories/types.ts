import type {
  AccountId,
  EvaluationId,
  ImmutableReportSnapshot,
  Interview,
  InterviewEvent,
  InterviewId,
  InterviewQuestionCount,
  InterviewStatus,
  ModelCallMetadata,
  OperationId,
  QuestionEvaluation,
  ReportId,
  ReportKind,
} from "@interview-agent/domain";

import type { JsonObject } from "../schema/interview.js";

export interface EvaluationPersistence {
  readonly evaluationId: EvaluationId;
  readonly questionPosition: number;
  readonly evaluation: QuestionEvaluation;
  readonly modelMetadata: ModelCallMetadata;
  readonly createdAt: Date;
}

export interface ReportPersistence {
  readonly id: ReportId;
  readonly kind: ReportKind;
  readonly schemaVersion: string;
  readonly snapshot: ImmutableReportSnapshot;
  readonly modelMetadata: ModelCallMetadata;
  readonly createdAt: Date;
}

export interface InterviewSave {
  readonly previous: Interview;
  readonly current: Interview;
  readonly events: readonly InterviewEvent[];
  readonly evaluations?: readonly EvaluationPersistence[];
  readonly report?: ReportPersistence;
}

export interface StoredReport {
  readonly id: ReportId;
  readonly interviewId: InterviewId;
  readonly accountId: AccountId;
  readonly kind: ReportKind;
  readonly schemaVersion: string;
  readonly snapshot: ImmutableReportSnapshot;
  readonly modelMetadata: ModelCallMetadata;
  readonly createdAt: Date;
}

export interface CreateStoredReport extends ReportPersistence {
  readonly interviewId: InterviewId;
  readonly accountId: AccountId;
}

export interface InterviewHistoryEntry {
  readonly interviewId: InterviewId;
  readonly createdAt: Date;
  readonly endedAt: Date;
  readonly direction: "go_backend";
  readonly questionCount: InterviewQuestionCount;
  readonly status: Extract<InterviewStatus, "completed" | "early_ended" | "abandoned">;
  readonly overallScore: number | null;
  readonly reportId: ReportId | null;
}

export interface TranscriptMessage {
  readonly id: string;
  readonly operationId: OperationId | null;
  readonly role: "user" | "assistant" | "system";
  readonly kind:
    | "main_answer"
    | "follow_up_answer"
    | "supplement"
    | "question_clarification"
    | "system_follow_up"
    | "transition";
  readonly content: string;
  readonly createdAt: Date;
}

export interface InterviewTranscriptQuestion {
  readonly position: number;
  readonly displayedQuestion: string;
  readonly messages: readonly TranscriptMessage[];
}

export interface InterviewDetail {
  readonly interview: Omit<Interview, "blueprint" | "questions"> & {
    readonly blueprint: Omit<Interview["blueprint"], "questions"> & {
      readonly questions: Interview["blueprint"]["questions"];
    };
    readonly questions: Interview["questions"];
  };
  readonly endedAt: Date | null;
  readonly questions: readonly InterviewTranscriptQuestion[];
}

export const OPERATION_TYPES = [
  "create_interview",
  "submit_answer",
  "submit_supplement",
  "request_question_clarification",
  "mark_question_unknown",
  "skip_question",
  "continue_interview",
  "end_interview_early",
  "abandon_interview",
  "retry_operation",
  "generate_report",
] as const;

export type OperationType = (typeof OPERATION_TYPES)[number];
export type OperationStatus = "pending" | "processing" | "succeeded" | "failed";

export interface StoredOperation {
  readonly id: OperationId;
  readonly accountId: AccountId;
  readonly interviewId: InterviewId;
  readonly idempotencyScope: OperationType;
  readonly idempotencyKey: string;
  readonly type: OperationType;
  readonly status: OperationStatus;
  readonly expectedVersion: number;
  readonly attemptCount: number;
  readonly lastAttemptAt: Date | null;
  readonly leaseAcquiredAt: Date | null;
  readonly leaseExpiresAt: Date | null;
  readonly input: JsonObject;
  readonly result: JsonObject | null;
  readonly error: JsonObject | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
}

export interface CreateOperation {
  readonly id: OperationId;
  readonly accountId: AccountId;
  readonly interviewId: InterviewId;
  readonly type: OperationType;
  readonly idempotencyKey: string;
  readonly expectedVersion: number;
  readonly input: JsonObject;
  readonly createdAt: Date;
}

export interface StartProcessingOperation {
  readonly operationId: OperationId;
  readonly accountId: AccountId;
  readonly expectedStatus: "pending";
  readonly startedAt: Date;
  readonly leaseExpiresAt: Date;
}

export type OperationResultUpdate =
  | {
      readonly operationId: OperationId;
      readonly accountId: AccountId;
      readonly expectedStatus: "pending" | "processing";
      readonly status: "succeeded";
      readonly result: JsonObject;
      readonly completedAt: Date;
    }
  | {
      readonly operationId: OperationId;
      readonly accountId: AccountId;
      readonly expectedStatus: "pending" | "processing";
      readonly status: "failed";
      readonly error: JsonObject;
      readonly completedAt: Date;
    };
