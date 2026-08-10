import type {
  AnswerMaterialId,
  EvaluationId,
  FollowUpGoalId,
  QuestionId,
  RubricItemId,
} from "./identifiers.js";

export const INTERVIEW_STATUSES = [
  "active",
  "report_pending",
  "completed",
  "early_ended",
  "abandoned",
  "deleting",
] as const;

export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];

export const INTERVIEW_PHASES = ["awaiting_response", "processing", "awaiting_continue"] as const;

export type InterviewPhase = (typeof INTERVIEW_PHASES)[number];

export const TERMINAL_INTERVIEW_STATUSES = [
  "completed",
  "early_ended",
  "abandoned",
  "deleting",
] as const satisfies readonly InterviewStatus[];

export type TerminalInterviewStatus = (typeof TERMINAL_INTERVIEW_STATUSES)[number];

export const REPORT_KINDS = ["complete", "incomplete"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const QUESTION_OUTCOME_KINDS = [
  "scored",
  "incorrect",
  "unknown",
  "skipped",
  "irrelevant",
] as const;
export type QuestionOutcomeKind = (typeof QUESTION_OUTCOME_KINDS)[number];

export const ZERO_SCORE_REASONS = ["unknown", "skipped", "irrelevant", "incorrect"] as const;
export type ZeroScoreReason = (typeof ZERO_SCORE_REASONS)[number];

export const FOLLOW_UP_KINDS = ["clarification", "depth"] as const;
export type FollowUpKind = (typeof FOLLOW_UP_KINDS)[number];

export const QUESTION_TYPES = ["conceptual", "scenario", "design", "troubleshooting"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const FOLLOW_UP_PURPOSES = [
  "answer_clarification",
  "irrelevant_response_clarification",
  "depth",
] as const;
export type FollowUpPurpose = (typeof FOLLOW_UP_PURPOSES)[number];

export const ANSWER_MATERIAL_KINDS = ["main_answer", "follow_up_answer", "supplement"] as const;
export type AnswerMaterialKind = (typeof ANSWER_MATERIAL_KINDS)[number];

export const RESPONSE_CLASSIFICATIONS = ["relevant", "ambiguous", "irrelevant"] as const;
export type ResponseClassification = (typeof RESPONSE_CLASSIFICATIONS)[number];

export const KNOWLEDGE_DOMAINS = [
  "go_language",
  "concurrency_runtime_performance",
  "http_rpc_api",
  "database_storage",
  "cache_messaging_distributed",
  "testing_observability_engineering",
] as const;

export type KnowledgeDomain = (typeof KNOWLEDGE_DOMAINS)[number];

export const SUPPORTED_QUESTION_COUNTS = [5, 10, 15] as const;
export type InterviewQuestionCount = (typeof SUPPORTED_QUESTION_COUNTS)[number];

export interface RubricItemSnapshot {
  readonly id: RubricItemId;
  readonly description: string;
  readonly weight: number;
}

export interface FollowUpGoalSnapshot {
  readonly id: FollowUpGoalId;
  readonly kind: FollowUpKind;
  readonly goal: string;
}

export interface QuestionDefinition {
  readonly questionId: QuestionId;
  readonly questionVersion: number;
  readonly domain: KnowledgeDomain;
  readonly difficulty: "medium";
  readonly questionType: QuestionType;
  readonly sourceWording: string;
  readonly rubric: readonly RubricItemSnapshot[];
  readonly followUpGoals: readonly FollowUpGoalSnapshot[];
  readonly knowledgeExplanation: string;
  readonly active: boolean;
  readonly reviewed: boolean;
  readonly reviewMetadata: {
    readonly reviewedBy: string;
    readonly reviewedAt: Date;
    readonly simplifiedChineseVerified: true;
    readonly technicalTermsVerified: true;
  } | null;
}

export interface QuestionSnapshot {
  readonly questionId: QuestionId;
  readonly questionVersion: number;
  readonly domain: KnowledgeDomain;
  readonly sourceWording: string;
  readonly displayedWording: string;
  readonly rubric: readonly RubricItemSnapshot[];
  readonly followUpGoals: readonly FollowUpGoalSnapshot[];
  readonly knowledgeExplanation: string;
}

export interface InterviewBlueprintItem {
  readonly position: number;
  readonly question: QuestionSnapshot;
}

export interface InterviewBlueprint {
  readonly selectionSeed: string;
  readonly questions: readonly InterviewBlueprintItem[];
}

export interface AnswerMaterial {
  readonly id: AnswerMaterialId;
  readonly kind: AnswerMaterialKind;
  readonly text: string;
  readonly submittedAt: Date;
}

export interface RubricItemEvaluation {
  readonly rubricItemId: RubricItemId;
  readonly evidenceMaterialIds: readonly AnswerMaterialId[];
  readonly awardedPoints: number;
  readonly missingOrIncorrectPoints: readonly string[];
}

export interface FollowUpRecommendation {
  readonly goalId: FollowUpGoalId;
  readonly kind: FollowUpKind;
  readonly purpose: FollowUpPurpose;
}

declare const positiveQuestionScoreBrand: unique symbol;

export type PositiveQuestionScore = number & {
  readonly [positiveQuestionScoreBrand]: true;
};

export class InvalidQuestionScoreError extends Error {
  constructor(readonly score: number) {
    super("Positive question score must be an integer from 1 through 100");
    this.name = "InvalidQuestionScoreError";
  }
}

export function parsePositiveQuestionScore(score: number): PositiveQuestionScore {
  if (!Number.isInteger(score) || score < 1 || score > 100) {
    throw new InvalidQuestionScoreError(score);
  }

  return score as PositiveQuestionScore;
}

export interface ScoredQuestionOutcome {
  readonly kind: "scored";
  readonly score: PositiveQuestionScore;
}

export interface IncorrectQuestionOutcome {
  readonly kind: "incorrect";
  readonly score: 0;
  readonly zeroScoreReason: "incorrect";
}

export interface UnknownQuestionOutcome {
  readonly kind: "unknown";
  readonly score: 0;
  readonly zeroScoreReason: "unknown";
}

export interface SkippedQuestionOutcome {
  readonly kind: "skipped";
  readonly score: 0;
  readonly zeroScoreReason: "skipped";
}

export interface IrrelevantQuestionOutcome {
  readonly kind: "irrelevant";
  readonly score: 0;
  readonly zeroScoreReason: "irrelevant";
}

export type ZeroQuestionOutcome =
  | IncorrectQuestionOutcome
  | UnknownQuestionOutcome
  | SkippedQuestionOutcome
  | IrrelevantQuestionOutcome;

export type FixedZeroQuestionOutcome =
  | UnknownQuestionOutcome
  | SkippedQuestionOutcome
  | IrrelevantQuestionOutcome;

export type UnevaluatedQuestionOutcome = UnknownQuestionOutcome | SkippedQuestionOutcome;

export type EvaluatedQuestionOutcome =
  | ScoredQuestionOutcome
  | IncorrectQuestionOutcome
  | IrrelevantQuestionOutcome;

export type QuestionOutcome = EvaluatedQuestionOutcome | UnevaluatedQuestionOutcome;

interface QuestionEvaluationBase {
  readonly id: EvaluationId;
  readonly rubricItems: readonly RubricItemEvaluation[];
}

export interface QuestionEvaluationInput extends QuestionEvaluationBase {
  readonly classification: ResponseClassification;
}

export interface RelevantQuestionEvaluation extends QuestionEvaluationBase {
  readonly classification: "relevant" | "ambiguous";
  readonly outcome: ScoredQuestionOutcome | IncorrectQuestionOutcome;
}

export interface IrrelevantQuestionEvaluation extends QuestionEvaluationBase {
  readonly classification: "irrelevant";
  readonly outcome: IrrelevantQuestionOutcome;
}

export type QuestionEvaluation = RelevantQuestionEvaluation | IrrelevantQuestionEvaluation;

export function isTerminalInterviewStatus(
  status: InterviewStatus,
): status is TerminalInterviewStatus {
  return TERMINAL_INTERVIEW_STATUSES.some((terminalStatus) => terminalStatus === status);
}

export function isSupportedQuestionCount(value: number): value is InterviewQuestionCount {
  return SUPPORTED_QUESTION_COUNTS.some((questionCount) => questionCount === value);
}
