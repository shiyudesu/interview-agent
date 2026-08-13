import {
  aggregateCompleteInterviewScore,
  aggregateDomainScores,
  type ImmutableReportSnapshot,
  type Interview,
  type InterviewId,
  KNOWLEDGE_DOMAINS,
  parseImmutableReportSnapshot,
  type ReportAnalysisRequest,
  type ReportAnalysisResult,
  type ReportId,
  type ReportKind,
  type ReportQuestionInput,
} from "@interview-agent/domain";

import { OperationRunnerError } from "./operation-errors.js";

export function createReportAnalysisRequest(interview: Interview): ReportAnalysisRequest {
  if (interview.status !== "report_pending" || interview.pendingReportKind === null) {
    throw new OperationRunnerError(`Interview ${interview.id} is not awaiting a report`);
  }
  const selectedQuestions = interview.questions.filter((question) => question.outcome !== null);
  if (
    selectedQuestions.length === 0 ||
    (interview.pendingReportKind === "complete" &&
      selectedQuestions.length !== interview.questionCount)
  ) {
    throw new OperationRunnerError(`Interview ${interview.id} has invalid report coverage`);
  }

  const questions: ReportQuestionInput[] = selectedQuestions.map((questionState) => {
    const question = requiredBlueprintQuestion(interview, questionState.position);
    const outcome = questionState.outcome;
    if (outcome === null) {
      throw new OperationRunnerError(`Interview ${interview.id} report question has no outcome`);
    }
    if (questionState.evaluation === null) {
      if (outcome.kind !== "unknown" && outcome.kind !== "skipped") {
        throw new OperationRunnerError(
          `Interview ${interview.id} report question has no structured evaluation`,
        );
      }
      return {
        question,
        answerMaterial: [],
        evaluation: null,
        outcome,
      };
    }
    return {
      question,
      answerMaterial: questionState.answerMaterial,
      evaluation: questionState.evaluation,
    };
  });
  const assessedDomains = KNOWLEDGE_DOMAINS.filter((domain) =>
    questions.some((question) => question.question.domain === domain),
  );
  return {
    reportKind: interview.pendingReportKind,
    questions,
    assessedDomains,
  };
}

export function createReportPersistence(
  interview: Interview,
  reportKind: ReportKind,
  reportId: ReportId,
  createdAt: Date,
  analysis: ReportAnalysisResult,
) {
  const request = createReportAnalysisRequest(interview);
  if (
    request.reportKind !== reportKind ||
    analysis.perQuestion.length !== request.questions.length
  ) {
    throw new OperationRunnerError("Report analysis coverage does not match the interview");
  }

  const selectedQuestionStates = interview.questions.filter(
    (question) => question.outcome !== null,
  );
  const reportQuestions = selectedQuestionStates.map((questionState, index) => {
    const questionAnalysis = analysis.perQuestion[index];
    if (questionAnalysis === undefined) {
      throw new OperationRunnerError("Report analysis is missing question feedback");
    }
    return createReportQuestionFeedback(interview, questionState, questionAnalysis);
  });
  const selectedScores = selectedQuestionStates.map((questionState) => {
    const outcome = questionState.outcome;
    if (outcome === null) {
      throw new OperationRunnerError("Report question has no deterministic outcome");
    }
    return {
      domain: requiredBlueprintQuestion(interview, questionState.position).domain,
      outcome,
    };
  });
  const domains = aggregateDomainScores(selectedScores);
  const common = {
    reportId,
    interviewId: interview.id,
    accountId: interview.accountId,
    generatedAt: createdAt.toISOString(),
    overallExplanation: analysis.overallExplanation,
    strengths: analysis.strengths,
    weaknesses: analysis.weaknesses,
    priorities: analysis.priorities,
    learningSuggestions: analysis.learningSuggestions,
    schemaVersion: analysis.metadata.schemaVersion,
    modelMetadata: {
      provider: analysis.metadata.provider,
      modelId: analysis.metadata.modelId,
      promptVersion: analysis.metadata.promptVersion,
      schemaVersion: analysis.metadata.schemaVersion,
      questionVersion: analysis.metadata.questionVersion,
      purpose: analysis.metadata.purpose,
      latencyMs: analysis.metadata.latencyMs,
      tokens: {
        inputTokens: analysis.metadata.inputTokens,
        outputTokens: analysis.metadata.outputTokens,
      },
    },
    questionVersions: reportQuestions.map((question) => ({
      questionId: question.questionId,
      questionVersion: question.questionVersion,
    })),
    domains,
    questions: reportQuestions,
  };
  const snapshotValue =
    reportKind === "complete"
      ? {
          kind: "complete" as const,
          ...common,
          overallScore: aggregateCompleteInterviewScore(selectedScores, interview.questionCount)
            .overallScore,
        }
      : {
          kind: "incomplete" as const,
          ...common,
        };
  let snapshot: ImmutableReportSnapshot;
  try {
    snapshot = parseImmutableReportSnapshot(snapshotValue);
  } catch {
    throw new OperationRunnerError("Generated report snapshot is invalid");
  }
  return {
    id: reportId,
    kind: reportKind,
    schemaVersion: snapshot.schemaVersion,
    snapshot,
    modelMetadata: analysis.metadata,
    createdAt,
  };
}

function createReportQuestionFeedback(
  interview: Interview,
  questionState: Interview["questions"][number],
  analysis: ReportAnalysisResult["perQuestion"][number],
): ImmutableReportSnapshot["questions"][number] {
  const question = requiredBlueprintQuestion(interview, questionState.position);
  const outcome = questionState.outcome;
  if (outcome === null || analysis.questionId !== question.questionId) {
    throw new OperationRunnerError("Report question analysis order is invalid");
  }
  const questionReference = {
    source: "question_snapshot" as const,
    questionId: question.questionId,
  };
  const evaluationEvidenceIds = new Set(
    questionState.evaluation?.rubricItems.flatMap((item) => item.evidenceMaterialIds) ?? [],
  );
  const analysisEvidence = analysis.evidenceMaterialIds
    .filter((id) => evaluationEvidenceIds.has(id))
    .map((answerMaterialId) => ({
      source: "answer_material" as const,
      answerMaterialId,
    }));
  const matchedKnowledgePoints =
    questionState.evaluation?.rubricItems
      .filter((item) => item.awardedPoints > 0)
      .map((item) => ({
        rubricItemId: item.rubricItemId,
        summary: "回答中已体现该知识点。",
        awardedPoints: item.awardedPoints,
        evidence: item.evidenceMaterialIds.map((answerMaterialId) => ({
          source: "answer_material" as const,
          answerMaterialId,
        })),
      })) ?? [];
  const missingOrIncorrectPoints =
    questionState.evaluation === null
      ? [
          {
            rubricItemId: requiredRubricItemId(question, interview.id),
            summary:
              outcome.kind === "unknown"
                ? "该题涉及的知识点尚未掌握。"
                : "该题涉及的知识点尚未作答。",
            evidence: [questionReference],
          },
        ]
      : questionState.evaluation.rubricItems.flatMap((item) =>
          item.missingOrIncorrectPoints.map((summary) => ({
            rubricItemId: item.rubricItemId,
            summary,
            evidence: [questionReference],
          })),
        );
  const evidence = dedupeReportEvidence([
    questionReference,
    ...analysisEvidence,
    ...matchedKnowledgePoints.flatMap((point) => point.evidence),
  ]);
  const common = {
    questionId: question.questionId,
    questionVersion: question.questionVersion,
    domain: question.domain,
    position: questionState.position,
    displayedQuestion: question.displayedWording,
    answerSummary: analysis.answerSummary,
    matchedKnowledgePoints,
    missingOrIncorrectPoints,
    scoreRationale: analysis.scoreRationale,
    improvementSuggestions: analysis.improvementSuggestions,
    evidence,
  };
  return outcome.kind === "scored"
    ? {
        ...common,
        outcome: "scored",
        score: outcome.score,
      }
    : {
        ...common,
        outcome: outcome.kind,
        score: 0,
        zeroScoreReason: outcome.zeroScoreReason,
      };
}

function requiredBlueprintQuestion(interview: Interview, position: number) {
  const item = interview.blueprint.questions[position - 1];
  if (item === undefined || item.position !== position) {
    throw new OperationRunnerError(`Interview ${interview.id} question snapshot is unavailable`);
  }
  return item.question;
}

function requiredRubricItemId(
  question: Interview["blueprint"]["questions"][number]["question"],
  interviewId: InterviewId,
) {
  const rubricItem = question.rubric[0];
  if (rubricItem === undefined) {
    throw new OperationRunnerError(`Interview ${interviewId} question Rubric is unavailable`);
  }
  return rubricItem.id;
}

function dedupeReportEvidence(
  references: readonly ImmutableReportSnapshot["questions"][number]["evidence"][number][],
): readonly ImmutableReportSnapshot["questions"][number]["evidence"][number][] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key =
      reference.source === "answer_material"
        ? `answer:${reference.answerMaterialId}`
        : `question:${reference.questionId}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
