import type {
  AccountId,
  AnswerMaterialId,
  FollowUpGoalId,
  InterviewId,
  MessageId,
  OperationId,
  ReportId,
} from "./identifiers.js";
import type {
  AnswerMaterialKind,
  FollowUpKind,
  FollowUpPurpose,
  InterviewBlueprint,
  InterviewQuestionCount,
  QuestionEvaluation,
  ReportKind,
  ResponseClassification,
  UnevaluatedQuestionOutcome,
} from "./interview.js";

interface InterviewEventBase<Type extends string> {
  readonly type: Type;
  readonly interviewId: InterviewId;
  readonly operationId: OperationId;
  readonly occurredAt: Date;
}

export interface InterviewCreatedEvent extends InterviewEventBase<"interview_created"> {
  readonly accountId: AccountId;
  readonly questionCount: InterviewQuestionCount;
  readonly blueprint: InterviewBlueprint;
}

export interface AnswerMaterialSubmittedEvent
  extends InterviewEventBase<"answer_material_submitted"> {
  readonly answerMaterialId: AnswerMaterialId;
  readonly materialKind: AnswerMaterialKind;
  readonly questionPosition: number;
  readonly text: string;
}

export interface QuestionClarificationRequestedEvent
  extends InterviewEventBase<"question_clarification_requested"> {
  readonly questionPosition: number;
}

export interface QuestionClarificationRecordedEvent
  extends InterviewEventBase<"question_clarification_recorded"> {
  readonly messageId: MessageId;
  readonly questionPosition: number;
  readonly text: string;
}

export interface SystemFollowUpRecordedEvent
  extends InterviewEventBase<"system_follow_up_recorded"> {
  readonly messageId: MessageId;
  readonly questionPosition: number;
  readonly goalId: FollowUpGoalId;
  readonly kind: FollowUpKind;
  readonly purpose: FollowUpPurpose;
  readonly responseClassification: ResponseClassification;
  readonly text: string;
}

export interface QuestionOutcomeClearedEvent
  extends InterviewEventBase<"question_outcome_cleared"> {
  readonly questionPosition: number;
}

export interface QuestionEvaluationRecordedEvent
  extends InterviewEventBase<"question_evaluation_recorded"> {
  readonly questionPosition: number;
  readonly evaluation: QuestionEvaluation;
}

export interface UnevaluatedQuestionOutcomeRecordedEvent
  extends InterviewEventBase<"unevaluated_question_outcome_recorded"> {
  readonly questionPosition: number;
  readonly outcome: UnevaluatedQuestionOutcome;
}

export interface QuestionFrozenEvent extends InterviewEventBase<"question_frozen"> {
  readonly questionPosition: number;
}

export interface ReportRequestedEvent extends InterviewEventBase<"report_requested"> {
  readonly reportKind: ReportKind;
}

export interface ReportStoredEvent extends InterviewEventBase<"report_stored"> {
  readonly reportId: ReportId;
  readonly reportKind: ReportKind;
}

export interface InterviewAbandonedEvent extends InterviewEventBase<"interview_abandoned"> {
  readonly reason: "user" | "expired";
}

export type InterviewEvent =
  | InterviewCreatedEvent
  | AnswerMaterialSubmittedEvent
  | QuestionClarificationRequestedEvent
  | QuestionClarificationRecordedEvent
  | SystemFollowUpRecordedEvent
  | QuestionOutcomeClearedEvent
  | QuestionEvaluationRecordedEvent
  | UnevaluatedQuestionOutcomeRecordedEvent
  | QuestionFrozenEvent
  | ReportRequestedEvent
  | ReportStoredEvent
  | InterviewAbandonedEvent;
