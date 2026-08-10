import type {
  CompleteInterviewScore,
  DomainScoreResult,
  QuestionOutcome,
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

export function mapInternalReportSnapshotToPublic(value: unknown): ReportResponseDto {
  const snapshot = checkDto(InternalReportSnapshotSchema, value, "internal report snapshot");
  const issues = validateInternalReportSnapshot(snapshot);
  if (issues.length > 0) {
    throw new ContractMappingError("internal report snapshot", issues);
  }
  const common = {
    kind: snapshot.kind,
    reportId: String(snapshot.reportId),
    interviewId: String(snapshot.interviewId),
    generatedAt: snapshot.generatedAt,
    domains: snapshot.domains.map((result) =>
      mapDomainScoreResultToDto(result as DomainScoreResult),
    ),
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
          overallScore: snapshot.overallScore,
        }
      : {
          ...common,
          kind: "incomplete",
        },
    "public report",
  );
}
