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
  type ZeroQuestionOutcome,
} from "@interview-agent/domain";

import { OperationRunnerError } from "./operation-errors.js";
import {
  createQuestionPrivateContentScope,
  exposesFragmentedPrivateContent,
  exposesPrivateContent,
  mergePrivateContentScopes,
} from "./private-assessment-content.js";

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
  assertNoPrivateReportContent(request, analysis);

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
  const reportText = createGlobalReportText(selectedQuestionStates, selectedScores, analysis);
  const common = {
    reportId,
    interviewId: interview.id,
    accountId: interview.accountId,
    generatedAt: createdAt.toISOString(),
    ...reportText,
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

function createGlobalReportText(
  questionStates: readonly Interview["questions"][number][],
  scores: readonly { readonly outcome: NonNullable<Interview["questions"][number]["outcome"]> }[],
  analysis: ReportAnalysisResult,
): Pick<
  ImmutableReportSnapshot,
  "overallExplanation" | "strengths" | "weaknesses" | "priorities" | "learningSuggestions"
> {
  if (!scores.every(({ outcome }) => outcome.score === 0)) {
    return {
      overallExplanation: analysis.overallExplanation,
      strengths: analysis.strengths,
      weaknesses: analysis.weaknesses,
      priorities: analysis.priorities,
      learningSuggestions: analysis.learningSuggestions,
    };
  }
  const hasEvaluatedAnswer = questionStates.some(({ evaluation }) => evaluation !== null);
  return {
    overallExplanation: hasEvaluatedAnswer
      ? "本次已完成题目均未确认已掌握的知识点；报告依据作答记录区分错误、偏题和未作答原因。"
      : "本次没有可用于分析知识掌握情况的作答材料；报告仅记录未掌握或跳过的题目及后续学习方向。",
    strengths: [
      hasEvaluatedAnswer
        ? "你完成了作答并留下了可用于定位误区的材料。"
        : "你明确记录了尚未掌握或选择跳过的题目，便于安排后续学习。",
    ],
    weaknesses: ["本次没有确认已掌握的知识点。"],
    priorities: ["优先处理各题反馈中列出的未掌握、偏题或错误概念。"],
    learningSuggestions: ["按题目顺序补齐核心概念、机制和适用边界，再重新作答并复盘。"],
  };
}

function assertNoPrivateReportContent(
  request: ReportAnalysisRequest,
  analysis: ReportAnalysisResult,
): void {
  const scopes = request.questions.map(({ question }) =>
    createQuestionPrivateContentScope(question),
  );
  const aggregateScope = mergePrivateContentScopes(scopes);
  const visibleText = [
    analysis.overallExplanation,
    ...analysis.strengths,
    ...analysis.weaknesses,
    ...analysis.priorities,
    ...analysis.learningSuggestions,
    ...request.questions.flatMap((questionInput, index) => {
      const questionAnalysis = analysis.perQuestion[index];
      if (questionAnalysis === undefined) {
        throw new OperationRunnerError("Report analysis is missing question feedback");
      }
      return [
        questionAnalysis.answerSummary,
        questionAnalysis.scoreRationale,
        ...questionAnalysis.improvementSuggestions,
        ...(questionInput.evaluation?.rubricItems.flatMap(
          ({ missingOrIncorrectPoints }) => missingOrIncorrectPoints,
        ) ?? []),
      ];
    }),
  ];
  if (
    visibleText.some((value) => exposesPrivateContent(value, aggregateScope)) ||
    exposesFragmentedPrivateContent(visibleText, aggregateScope)
  ) {
    throw new OperationRunnerError("Generated report contains private assessment content");
  }
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
  const acceptedEvidenceIds = new Set(questionState.answerMaterial.map(({ id }) => id));
  const evaluationEvidenceIds = new Set(
    questionState.evaluation?.rubricItems.flatMap((item) => item.evidenceMaterialIds) ?? [],
  );
  const analysisEvidenceIds = new Set(analysis.evidenceMaterialIds);
  if (
    analysisEvidenceIds.size !== analysis.evidenceMaterialIds.length ||
    analysis.evidenceMaterialIds.some((id) => !acceptedEvidenceIds.has(id)) ||
    (questionState.evaluation === null
      ? analysis.evidenceMaterialIds.length > 0
      : analysis.evidenceMaterialIds.length === 0) ||
    [...evaluationEvidenceIds].some((id) => !analysisEvidenceIds.has(id))
  ) {
    throw new OperationRunnerError("Report question analysis evidence is invalid");
  }
  const analysisEvidence = analysis.evidenceMaterialIds.map((answerMaterialId) => ({
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
                ? `围绕“${question.displayedWording}”所需的核心知识尚未获得作答证据。`
                : `你跳过了“${question.displayedWording}”，相关核心知识尚未通过作答体现。`,
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
    ...(outcome.kind === "scored"
      ? {
          answerSummary: analysis.answerSummary,
          scoreRationale: analysis.scoreRationale,
          improvementSuggestions: analysis.improvementSuggestions,
        }
      : createZeroPointFeedbackText(outcome, question.displayedWording, analysis)),
    matchedKnowledgePoints,
    missingOrIncorrectPoints,
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

export function createZeroPointFeedbackText(
  outcome: ZeroQuestionOutcome,
  displayedQuestion: string,
  analysis: ReportAnalysisResult["perQuestion"][number],
): Pick<
  ImmutableReportSnapshot["questions"][number],
  "answerSummary" | "scoreRationale" | "improvementSuggestions"
> {
  const assessmentGoal = `本题要求回应：“${displayedQuestion}”`;
  switch (outcome.kind) {
    case "unknown":
      return {
        answerSummary: "你明确表示暂未掌握本题相关内容，因此没有可用于分析的作答材料。",
        scoreRationale: `${assessmentGoal}；相关知识点尚未获得作答证据。`,
        improvementSuggestions: [
          "先梳理题目中的技术对象、核心机制和适用边界，学习后再用自己的话完整回答。",
        ],
      };
    case "skipped":
      return {
        answerSummary: "你主动选择跳过本题，因此没有可用于分析的作答材料。",
        scoreRationale: `${assessmentGoal}；由于未作答，相关知识点尚未获得作答证据。`,
        improvementSuggestions: [
          "补做本题时先明确问题要求，再围绕技术对象、核心机制和适用边界组织回答。",
        ],
      };
    case "irrelevant":
      return {
        answerSummary: `提交内容没有回应“${displayedQuestion}”所询问的技术主题。 ${analysis.answerSummary}`,
        scoreRationale: `作答偏离了问题要求，无法据此确认相关知识点。 ${analysis.scoreRationale}`,
        improvementSuggestions: withRequiredSuggestion(
          "重新审题，先明确问题要求说明的技术对象和边界，再围绕该主题组织回答。",
          analysis.improvementSuggestions,
        ),
      };
    case "incorrect":
      return {
        answerSummary: `作答与题目相关，但结构化评估确认其中存在错误理解。 ${analysis.answerSummary}`,
        scoreRationale: `下方列出的缺失或错误知识点是需要纠正的具体概念。 ${analysis.scoreRationale}`,
        improvementSuggestions: withRequiredSuggestion(
          "对照缺失或错误知识点逐项纠正概念边界，再通过示例验证新的理解。",
          analysis.improvementSuggestions,
        ),
      };
  }
}

function withRequiredSuggestion(
  required: string,
  modelSuggestions: readonly string[],
): readonly string[] {
  return [
    required,
    ...modelSuggestions.filter((suggestion) => suggestion !== required).slice(0, 5),
  ];
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
