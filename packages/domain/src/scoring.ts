import type { AnswerMaterialId, RubricItemId } from "./identifiers.js";
import {
  type InterviewQuestionCount,
  KNOWLEDGE_DOMAINS,
  type KnowledgeDomain,
  parsePositiveQuestionScore,
  type QuestionEvaluation,
  type QuestionEvaluationInput,
  type QuestionOutcome,
  type RubricItemSnapshot,
  type ZeroQuestionOutcome,
  type ZeroScoreReason,
} from "./interview.js";

export type RubricValidationErrorCode =
  | "rubric_empty"
  | "duplicate_rubric_item"
  | "invalid_rubric_weight"
  | "invalid_rubric_total";

export type AwardValidationErrorCode =
  | "award_count_mismatch"
  | "invalid_rubric_item"
  | "duplicate_rubric_award"
  | "invalid_awarded_points"
  | "missing_evidence"
  | "invalid_evidence_reference"
  | "irrelevant_awarded_points";

export type AggregationErrorCode = "question_count_mismatch";

export class ScoringError<Code extends string> extends Error {
  constructor(
    readonly code: Code,
    message: string,
  ) {
    super(message);
    this.name = "ScoringError";
  }
}

export class InvalidRubricError extends ScoringError<RubricValidationErrorCode> {
  constructor(
    code: RubricValidationErrorCode,
    message: string,
    readonly rubricItemId: RubricItemId | null = null,
  ) {
    super(code, message);
    this.name = "InvalidRubricError";
  }
}

export class InvalidRubricAwardError extends ScoringError<AwardValidationErrorCode> {
  constructor(
    code: AwardValidationErrorCode,
    message: string,
    readonly rubricItemId: RubricItemId | null = null,
    readonly evidenceMaterialId: AnswerMaterialId | null = null,
  ) {
    super(code, message);
    this.name = "InvalidRubricAwardError";
  }
}

export class InvalidScoreAggregationError extends ScoringError<AggregationErrorCode> {
  constructor(
    readonly expectedQuestionCount: InterviewQuestionCount,
    readonly actualQuestionCount: number,
  ) {
    super(
      "question_count_mismatch",
      `Complete interview scoring requires exactly ${expectedQuestionCount} questions, received ${actualQuestionCount}`,
    );
    this.name = "InvalidScoreAggregationError";
  }
}

export interface ValidatedRubric {
  readonly itemCount: number;
  readonly totalWeight: 100;
}

export function validateRubric(rubric: readonly RubricItemSnapshot[]): ValidatedRubric {
  if (rubric.length === 0) {
    throw new InvalidRubricError("rubric_empty", "Rubric cannot be empty");
  }

  const itemIds = new Set<RubricItemId>();
  let totalWeight = 0;
  for (const item of rubric) {
    if (itemIds.has(item.id)) {
      throw new InvalidRubricError(
        "duplicate_rubric_item",
        `Duplicate Rubric item ${item.id}`,
        item.id,
      );
    }
    itemIds.add(item.id);
    if (!Number.isInteger(item.weight) || item.weight < 1 || item.weight > 100) {
      throw new InvalidRubricError(
        "invalid_rubric_weight",
        "Rubric weights must be integers from 1 through 100",
        item.id,
      );
    }
    totalWeight += item.weight;
  }

  if (totalWeight !== 100) {
    throw new InvalidRubricError(
      "invalid_rubric_total",
      `Rubric weights must total 100, received ${totalWeight}`,
    );
  }

  return { itemCount: rubric.length, totalWeight: 100 };
}

export interface ScoreQuestionInput {
  readonly rubric: readonly RubricItemSnapshot[];
  readonly evaluation: QuestionEvaluationInput;
  readonly validEvidenceMaterialIds: ReadonlySet<AnswerMaterialId>;
}

export function scoreQuestion(input: ScoreQuestionInput): QuestionEvaluation {
  validateRubric(input.rubric);
  const rubricById = new Map(input.rubric.map((item) => [item.id, item] as const));
  const awardedIds = new Set<RubricItemId>();

  if (input.evaluation.rubricItems.length !== input.rubric.length) {
    throw new InvalidRubricAwardError(
      "award_count_mismatch",
      "Evaluation must include every Rubric item",
    );
  }

  let score = 0;
  for (const award of input.evaluation.rubricItems) {
    const rubricItem = rubricById.get(award.rubricItemId);
    if (rubricItem === undefined) {
      throw new InvalidRubricAwardError(
        "invalid_rubric_item",
        `Unknown Rubric item ${award.rubricItemId}`,
        award.rubricItemId,
      );
    }
    if (awardedIds.has(award.rubricItemId)) {
      throw new InvalidRubricAwardError(
        "duplicate_rubric_award",
        `Duplicate award for Rubric item ${award.rubricItemId}`,
        award.rubricItemId,
      );
    }
    awardedIds.add(award.rubricItemId);
    if (
      !Number.isInteger(award.awardedPoints) ||
      award.awardedPoints < 0 ||
      award.awardedPoints > rubricItem.weight
    ) {
      throw new InvalidRubricAwardError(
        "invalid_awarded_points",
        `Awarded points for ${award.rubricItemId} must be an integer from 0 through ${rubricItem.weight}`,
        award.rubricItemId,
      );
    }
    if (award.awardedPoints > 0 && award.evidenceMaterialIds.length === 0) {
      throw new InvalidRubricAwardError(
        "missing_evidence",
        `Awarded points for ${award.rubricItemId} require answer-material evidence`,
        award.rubricItemId,
      );
    }
    for (const evidenceMaterialId of award.evidenceMaterialIds) {
      if (!input.validEvidenceMaterialIds.has(evidenceMaterialId)) {
        throw new InvalidRubricAwardError(
          "invalid_evidence_reference",
          `Unknown answer material ${evidenceMaterialId}`,
          award.rubricItemId,
          evidenceMaterialId,
        );
      }
    }
    score += award.awardedPoints;
  }

  const rubricItems = Object.freeze(
    input.evaluation.rubricItems.map((award) =>
      Object.freeze({
        ...award,
        evidenceMaterialIds: Object.freeze([...award.evidenceMaterialIds]),
        missingOrIncorrectPoints: Object.freeze([...award.missingOrIncorrectPoints]),
      }),
    ),
  );

  if (input.evaluation.classification === "irrelevant") {
    if (score !== 0) {
      throw new InvalidRubricAwardError(
        "irrelevant_awarded_points",
        "Irrelevant evaluations cannot award points",
      );
    }
    return Object.freeze({
      id: input.evaluation.id,
      classification: "irrelevant",
      rubricItems,
      outcome: createZeroQuestionOutcome("irrelevant"),
    });
  }

  if (score === 0) {
    return Object.freeze({
      id: input.evaluation.id,
      classification: input.evaluation.classification,
      rubricItems,
      outcome: createZeroQuestionOutcome("incorrect"),
    });
  }

  return Object.freeze({
    id: input.evaluation.id,
    classification: input.evaluation.classification,
    rubricItems,
    outcome: Object.freeze({
      kind: "scored",
      score: parsePositiveQuestionScore(score),
    }),
  });
}

type ZeroQuestionOutcomeFor<Reason extends ZeroScoreReason> = Extract<
  ZeroQuestionOutcome,
  { readonly zeroScoreReason: Reason }
>;

export function createZeroQuestionOutcome<Reason extends ZeroScoreReason>(
  reason: Reason,
): ZeroQuestionOutcomeFor<Reason>;
export function createZeroQuestionOutcome(reason: ZeroScoreReason): ZeroQuestionOutcome;
export function createZeroQuestionOutcome(reason: ZeroScoreReason): ZeroQuestionOutcome {
  switch (reason) {
    case "unknown":
      return Object.freeze({ kind: "unknown", score: 0, zeroScoreReason: "unknown" });
    case "skipped":
      return Object.freeze({ kind: "skipped", score: 0, zeroScoreReason: "skipped" });
    case "irrelevant":
      return Object.freeze({ kind: "irrelevant", score: 0, zeroScoreReason: "irrelevant" });
    case "incorrect":
      return Object.freeze({ kind: "incorrect", score: 0, zeroScoreReason: "incorrect" });
  }
}

declare const domainScoreBrand: unique symbol;
declare const overallScoreBrand: unique symbol;

export type DomainScore = number & { readonly [domainScoreBrand]: true };
export type OverallScore = number & { readonly [overallScoreBrand]: true };

export interface SelectedQuestionScore {
  readonly domain: KnowledgeDomain;
  readonly outcome: QuestionOutcome;
}

export interface AssessedDomainScore {
  readonly status: "assessed";
  readonly domain: KnowledgeDomain;
  readonly score: DomainScore;
  readonly questionCount: number;
}

export interface UnassessedDomainScore {
  readonly status: "unassessed";
  readonly domain: KnowledgeDomain;
}

export type DomainScoreResult = AssessedDomainScore | UnassessedDomainScore;

export interface CompleteInterviewScore {
  readonly overallScore: OverallScore;
  readonly domains: readonly DomainScoreResult[];
}

export function aggregateDomainScores(
  questions: readonly SelectedQuestionScore[],
): readonly DomainScoreResult[] {
  return KNOWLEDGE_DOMAINS.map((domain) => {
    const scores = questions
      .filter((question) => question.domain === domain)
      .map((question) => question.outcome.score);
    if (scores.length === 0) {
      return { status: "unassessed", domain };
    }
    return {
      status: "assessed",
      domain,
      score: roundedAverage(scores) as DomainScore,
      questionCount: scores.length,
    };
  });
}

export function aggregateCompleteInterviewScore(
  questions: readonly SelectedQuestionScore[],
  expectedQuestionCount: InterviewQuestionCount,
): CompleteInterviewScore {
  if (questions.length !== expectedQuestionCount) {
    throw new InvalidScoreAggregationError(expectedQuestionCount, questions.length);
  }
  return {
    overallScore: roundedAverage(
      questions.map((question) => question.outcome.score),
    ) as OverallScore,
    domains: aggregateDomainScores(questions),
  };
}

function roundedAverage(scores: readonly number[]): number {
  return Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length);
}
