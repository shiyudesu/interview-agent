import type {
  CompleteInterviewScore,
  DomainScoreResult,
  InterviewQuestionCount,
  QuestionOutcome,
} from "@interview-agent/domain";
import {
  aggregateCompleteInterviewScore,
  aggregateDomainScores,
  createZeroQuestionOutcome,
  deriveEvaluatedQuestionOutcome,
  InvalidRubricAwardError,
  isSupportedQuestionCount,
  parseRubricItemId,
} from "@interview-agent/domain";

import { ContractMappingError, checkDto, parseMappedDto } from "./mapping-validation.js";
import {
  type DomainResultDto,
  DomainResultSchema,
  type InternalReportQuestionFeedbackDto,
  InternalReportSnapshotSchema,
  type QuestionOutcomeScoreDto,
  QuestionOutcomeScoreSchema,
  type ReportResponseDto,
  ReportResponseSchema,
  validateInternalReportSnapshot,
} from "./reports.js";

export interface PublicCompleteScoreDto {
  readonly overallScore: number;
  readonly domains: readonly DomainResultDto[];
}

export function mapQuestionOutcomeToDto(outcome: QuestionOutcome): QuestionOutcomeScoreDto {
  return parseMappedDto(
    QuestionOutcomeScoreSchema,
    outcome.kind === "scored"
      ? {
          outcome: "scored",
          score: outcome.score,
        }
      : {
          outcome: outcome.kind,
          score: 0,
          zeroScoreReason: outcome.zeroScoreReason,
        },
    "question outcome",
  );
}

export function mapDomainScoreResultToDto(result: DomainScoreResult): DomainResultDto {
  return parseMappedDto(
    DomainResultSchema,
    result.status === "unassessed"
      ? {
          status: "unassessed",
          domain: result.domain,
        }
      : {
          status: "assessed",
          domain: result.domain,
          score: result.score,
          questionCount: result.questionCount,
        },
    "domain score",
  );
}

export function mapCompleteInterviewScoreToDto(
  score: CompleteInterviewScore,
): PublicCompleteScoreDto {
  return {
    overallScore: score.overallScore,
    domains: score.domains.map(mapDomainScoreResultToDto),
  };
}

function mapQuestionFeedback(question: InternalReportQuestionFeedbackDto) {
  const common = {
    position: question.position,
    displayedQuestion: question.displayedQuestion,
    answerSummary: question.answerSummary,
    matchedKnowledgePoints: question.matchedKnowledgePoints.map((point) => point.summary),
    missingOrIncorrectPoints: question.missingOrIncorrectPoints.map((point) => point.summary),
    scoreRationale: question.scoreRationale,
    improvementSuggestions: [...question.improvementSuggestions],
  };
  if (question.outcome === "scored") {
    return {
      ...common,
      outcome: "scored",
      score: question.score,
    };
  }
  return {
    ...common,
    outcome: question.outcome,
    score: 0,
    zeroScoreReason: question.zeroScoreReason,
  };
}

function questionOutcome(question: InternalReportQuestionFeedbackDto): QuestionOutcome {
  let derivedOutcome: ReturnType<typeof deriveEvaluatedQuestionOutcome>;
  try {
    derivedOutcome = deriveEvaluatedQuestionOutcome({
      classification: question.outcome === "irrelevant" ? "irrelevant" : "relevant",
      rubricItems: question.matchedKnowledgePoints.map((point) => ({
        rubricItemId: parseRubricItemId(point.rubricItemId),
        evidenceMaterialIds: [],
        awardedPoints: point.awardedPoints,
        missingOrIncorrectPoints: [],
      })),
    });
  } catch (error) {
    if (error instanceof InvalidRubricAwardError) {
      throw new ContractMappingError("internal report snapshot", [
        {
          path: `/questions/${question.position - 1}/matchedKnowledgePoints`,
          code: error.code,
          message: error.message,
        },
      ]);
    }
    throw error;
  }
  if (question.outcome === "scored") {
    if (derivedOutcome.kind === "scored" && question.score === derivedOutcome.score) {
      return derivedOutcome;
    }
    throw new ContractMappingError("internal report snapshot", [
      {
        path: `/questions/${question.position - 1}/score`,
        code: "inconsistent_question_score",
        message: "Question score is inconsistent with awarded knowledge points",
      },
    ]);
  }
  if (
    (question.outcome === "incorrect" && derivedOutcome.kind !== "incorrect") ||
    (question.outcome === "irrelevant" && derivedOutcome.kind !== "irrelevant") ||
    ((question.outcome === "unknown" || question.outcome === "skipped") &&
      derivedOutcome.kind === "scored")
  ) {
    throw new ContractMappingError("internal report snapshot", [
      {
        path: `/questions/${question.position - 1}/score`,
        code: "inconsistent_question_score",
        message: "Question score is inconsistent with awarded knowledge points",
      },
    ]);
  }
  return createZeroQuestionOutcome(question.zeroScoreReason);
}

function assertDomainScoresMatch(
  supplied: readonly DomainResultDto[],
  computed: readonly DomainScoreResult[],
) {
  const issues = computed.flatMap((expected) => {
    const actual = supplied.find((result) => result.domain === expected.domain);
    if (
      actual === undefined ||
      actual.status !== expected.status ||
      (actual.status === "assessed" &&
        expected.status === "assessed" &&
        (actual.score !== expected.score || actual.questionCount !== expected.questionCount))
    ) {
      return [
        {
          path: "/domains",
          code: "inconsistent_domain_score",
          message: `Domain score for ${expected.domain} is inconsistent with question outcomes`,
        },
      ];
    }
    return [];
  });
  if (issues.length > 0) {
    throw new ContractMappingError("internal report snapshot", issues);
  }
}

function recomputeReportScores(snapshot: {
  readonly kind: "complete" | "incomplete";
  readonly questions: readonly InternalReportQuestionFeedbackDto[];
  readonly domains: readonly DomainResultDto[];
  readonly overallScore?: number;
}): {
  readonly domains: readonly DomainScoreResult[];
  readonly overallScore?: number;
} {
  const selectedQuestions = snapshot.questions.map((question) => ({
    domain: question.domain,
    outcome: questionOutcome(question),
  }));

  if (snapshot.kind === "complete") {
    if (!isSupportedQuestionCount(selectedQuestions.length)) {
      throw new ContractMappingError("internal report snapshot", [
        {
          path: "/questions",
          code: "invalid_complete_question_count",
          message: "Complete report question count is unsupported",
        },
      ]);
    }
    const score = aggregateCompleteInterviewScore(
      selectedQuestions,
      selectedQuestions.length as InterviewQuestionCount,
    );
    assertDomainScoresMatch(snapshot.domains, score.domains);
    if (snapshot.overallScore !== score.overallScore) {
      throw new ContractMappingError("internal report snapshot", [
        {
          path: "/overallScore",
          code: "inconsistent_overall_score",
          message: "Overall score is inconsistent with question outcomes",
        },
      ]);
    }
    return score;
  }

  const domains = aggregateDomainScores(selectedQuestions);
  assertDomainScoresMatch(snapshot.domains, domains);
  return { domains };
}

export function mapInternalReportSnapshotToPublic(value: unknown): ReportResponseDto {
  const snapshot = checkDto(InternalReportSnapshotSchema, value, "internal report snapshot");
  const issues = validateInternalReportSnapshot(snapshot);
  if (issues.length > 0) {
    throw new ContractMappingError("internal report snapshot", issues);
  }
  const scores = recomputeReportScores(snapshot);

  const common = {
    kind: snapshot.kind,
    reportId: String(snapshot.reportId),
    interviewId: String(snapshot.interviewId),
    generatedAt: snapshot.generatedAt,
    domains: scores.domains.map(mapDomainScoreResultToDto),
    questions: snapshot.questions.map(mapQuestionFeedback),
    overallExplanation: snapshot.overallExplanation,
    strengths: [...snapshot.strengths],
    weaknesses: [...snapshot.weaknesses],
    priorities: [...snapshot.priorities],
    learningSuggestions: [...snapshot.learningSuggestions],
  };
  return parseMappedDto(
    ReportResponseSchema,
    snapshot.kind === "complete"
      ? {
          ...common,
          kind: "complete",
          overallScore: scores.overallScore,
        }
      : {
          ...common,
          kind: "incomplete",
        },
    "public report",
  );
}
