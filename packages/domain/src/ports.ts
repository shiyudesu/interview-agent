import type {
  AccountId,
  AnswerMaterialId,
  FollowUpGoalId,
  InterviewId,
  QuestionId,
} from "./identifiers.js";
import type {
  AnswerMaterial,
  FollowUpGoalSnapshot,
  FollowUpPurpose,
  FollowUpRecommendation,
  InterviewBlueprint,
  InterviewQuestionCount,
  KnowledgeDomain,
  QuestionEvaluation,
  QuestionSnapshot,
  ReportKind,
  ResponseClassification,
  RubricItemEvaluation,
  UnevaluatedQuestionOutcome,
} from "./interview.js";

export interface AggregateChange<Aggregate, Event> {
  readonly previous: Aggregate;
  readonly current: Aggregate;
  readonly events: readonly Event[];
}

export interface InterviewRepository<Interview, SaveChange> {
  findById(interviewId: InterviewId, accountId?: AccountId): Promise<Interview | null>;
  findActiveByAccountId(accountId: AccountId): Promise<Interview | null>;
  create(interview: Interview): Promise<void>;
  save(change: SaveChange): Promise<void>;
}

export interface QuestionBankRepository {
  listActiveQuestions(): Promise<readonly QuestionSnapshot[]>;
  findQuestion(questionId: QuestionId, questionVersion: number): Promise<QuestionSnapshot | null>;
  findRecentQuestionIds(
    accountId: AccountId,
    completedInterviewLimit: number,
  ): Promise<ReadonlySet<QuestionId>>;
}

export interface BlueprintSelector {
  select(input: {
    readonly questionCount: InterviewQuestionCount;
    readonly selectionSeed: string;
    readonly eligibleQuestions: readonly QuestionSnapshot[];
    readonly recentQuestionIds: ReadonlySet<QuestionId>;
  }): InterviewBlueprint;
}

export interface ReportRepository<Report, NewReport> {
  findByInterviewId(interviewId: InterviewId, accountId: AccountId): Promise<Report | null>;
  insert(report: NewReport): Promise<void>;
}

export interface ModelCallMetadata {
  readonly provider: string;
  readonly modelId: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly questionVersion: number | null;
  readonly purpose: string;
  readonly latencyMs: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export type InterviewerTextRequest =
  | {
      readonly purpose: "rephrase_question";
      readonly question: QuestionSnapshot;
    }
  | {
      readonly purpose: "clarify_question";
      readonly question: QuestionSnapshot;
    }
  | {
      readonly purpose: "phrase_follow_up";
      readonly question: QuestionSnapshot;
      readonly goal: FollowUpGoalSnapshot;
      readonly followUpPurpose: FollowUpPurpose;
      readonly answerMaterial: readonly AnswerMaterial[];
    };

export type InterviewerTextEvent =
  | {
      readonly type: "delta";
      readonly text: string;
    }
  | {
      readonly type: "completed";
      readonly text: string;
      readonly metadata: ModelCallMetadata;
    };

export interface InterviewerTextModel {
  stream(request: InterviewerTextRequest): AsyncIterable<InterviewerTextEvent>;
}

export interface AnswerEvaluationRequest {
  readonly question: QuestionSnapshot;
  readonly answerMaterial: readonly AnswerMaterial[];
  readonly usedFollowUpGoalIds: ReadonlySet<FollowUpGoalId>;
}

export interface AnswerEvaluationResult {
  readonly classification: ResponseClassification;
  readonly rubricItems: readonly RubricItemEvaluation[];
  readonly recommendedFollowUpGoal: FollowUpRecommendation | null;
  readonly metadata: ModelCallMetadata;
}

export interface AnswerEvaluationModel {
  evaluate(request: AnswerEvaluationRequest): Promise<AnswerEvaluationResult>;
}

interface ReportQuestionInputBase {
  readonly question: QuestionSnapshot;
  readonly answerMaterial: readonly AnswerMaterial[];
}

export interface EvaluatedReportQuestionInput extends ReportQuestionInputBase {
  readonly evaluation: QuestionEvaluation;
}

export interface UnevaluatedReportQuestionInput extends ReportQuestionInputBase {
  readonly evaluation: null;
  readonly outcome: UnevaluatedQuestionOutcome;
}

export type ReportQuestionInput = EvaluatedReportQuestionInput | UnevaluatedReportQuestionInput;

export interface ReportAnalysisRequest {
  readonly reportKind: ReportKind;
  readonly questions: readonly ReportQuestionInput[];
  readonly assessedDomains: readonly KnowledgeDomain[];
}

export interface ReportQuestionAnalysis {
  readonly questionId: QuestionId;
  readonly answerSummary: string;
  readonly scoreRationale: string;
  readonly improvementSuggestions: readonly string[];
  readonly evidenceMaterialIds: readonly AnswerMaterialId[];
}

export interface ReportAnalysisResult {
  readonly overallExplanation: string;
  readonly strengths: readonly string[];
  readonly weaknesses: readonly string[];
  readonly priorities: readonly string[];
  readonly learningSuggestions: readonly string[];
  readonly perQuestion: readonly ReportQuestionAnalysis[];
  readonly metadata: ModelCallMetadata;
}

export interface ReportAnalysisModel {
  analyze(request: ReportAnalysisRequest): Promise<ReportAnalysisResult>;
}
