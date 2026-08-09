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
  FollowUpKind,
  FollowUpPurpose,
  InterviewBlueprint,
  InterviewQuestionCount,
  QuestionEvaluation,
  ReportKind,
  ResponseClassification,
} from "./interview.js";

interface InterviewCommandBase<Type extends string> {
  readonly type: Type;
  readonly interviewId: InterviewId;
  readonly operationId: OperationId;
  readonly expectedVersion: number;
  readonly occurredAt: Date;
}

export interface CreateInterviewCommand extends InterviewCommandBase<"create_interview"> {
  readonly accountId: AccountId;
  readonly questionCount: InterviewQuestionCount;
  readonly blueprint: InterviewBlueprint;
}

export interface SubmitAnswerCommand extends InterviewCommandBase<"submit_answer"> {
  readonly answerMaterialId: AnswerMaterialId;
  readonly text: string;
}

export interface SubmitSupplementCommand extends InterviewCommandBase<"submit_supplement"> {
  readonly answerMaterialId: AnswerMaterialId;
  readonly text: string;
}

export interface RequestQuestionClarificationCommand
  extends InterviewCommandBase<"request_question_clarification"> {}

export interface MarkQuestionUnknownCommand extends InterviewCommandBase<"mark_question_unknown"> {}

export interface SkipQuestionCommand extends InterviewCommandBase<"skip_question"> {}

export interface ContinueInterviewCommand extends InterviewCommandBase<"continue_interview"> {}

export interface EndInterviewEarlyCommand extends InterviewCommandBase<"end_interview_early"> {}

export interface AbandonInterviewCommand extends InterviewCommandBase<"abandon_interview"> {}

export interface ExpireInterviewCommand extends InterviewCommandBase<"expire_interview"> {}

export interface RecordQuestionClarificationCommand
  extends InterviewCommandBase<"record_question_clarification"> {
  readonly messageId: MessageId;
  readonly text: string;
}

export interface RecordSystemFollowUpCommand
  extends InterviewCommandBase<"record_system_follow_up"> {
  readonly messageId: MessageId;
  readonly goalId: FollowUpGoalId;
  readonly kind: FollowUpKind;
  readonly purpose: FollowUpPurpose;
  readonly responseClassification: ResponseClassification;
  readonly text: string;
}

export interface RecordQuestionEvaluationCommand
  extends InterviewCommandBase<"record_question_evaluation"> {
  readonly evaluation: QuestionEvaluation;
}

export interface RecordReportCommand extends InterviewCommandBase<"record_report"> {
  readonly reportId: ReportId;
  readonly reportKind: ReportKind;
}

export type UserInterviewCommand =
  | CreateInterviewCommand
  | SubmitAnswerCommand
  | SubmitSupplementCommand
  | RequestQuestionClarificationCommand
  | MarkQuestionUnknownCommand
  | SkipQuestionCommand
  | ContinueInterviewCommand
  | EndInterviewEarlyCommand
  | AbandonInterviewCommand;

export type SystemInterviewCommand =
  | ExpireInterviewCommand
  | RecordQuestionClarificationCommand
  | RecordSystemFollowUpCommand
  | RecordQuestionEvaluationCommand
  | RecordReportCommand;

export type InterviewCommand = UserInterviewCommand | SystemInterviewCommand;
