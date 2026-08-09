import {
  aggregateCompleteInterviewScore,
  createZeroQuestionOutcome,
  type Interview,
  InterviewDomainError,
  InterviewVersionConflictError,
  parseAccountId,
  parseAnswerMaterialId,
  parseInterviewId,
  parseMessageId,
  parseOperationId,
  parseReportId,
  type QuestionDefinition,
  type SelectedQuestionScore,
  scoreQuestion,
} from "@interview-agent/domain";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";

import {
  ContractMappingError,
  ErrorEnvelopeSchema,
  InternalQuestionEvaluationSchema,
  InternalQuestionSnapshotSchema,
  InterviewDetailResponseSchema,
  mapAbandonInterviewCommand,
  mapCompleteInterviewScoreToDto,
  mapContinueInterviewCommand,
  mapCreateInterviewCommand,
  mapDomainErrorToEnvelope,
  mapEndInterviewEarlyCommand,
  mapInternalQuestionSnapshotDtoToDomain,
  mapInternalReportSnapshotToPublic,
  mapInterviewToResponse,
  mapMarkQuestionUnknownCommand,
  mapQuestionBankQuestionDtoToDefinition,
  mapQuestionDefinitionToQuestionBankDto,
  mapQuestionDefinitionToSnapshot,
  mapQuestionEvaluationToInternalDto,
  mapQuestionOutcomeToDto,
  mapQuestionSnapshotToInternalDto,
  mapRequestQuestionClarificationCommand,
  mapRetryOperationInput,
  mapSkipQuestionCommand,
  mapStructuredAnswerEvaluationDto,
  mapSubmitAnswerCommand,
  mapSubmitSupplementCommand,
  ReportResponseSchema,
} from "../src/index.js";

const occurredAt = "2026-08-09T12:00:00.000Z";
const later = new Date("2026-08-09T13:00:00.000Z");

const questionBankQuestion = {
  id: "go.context.001",
  version: 7,
  domain: "go_language",
  difficulty: "medium",
  sourceWording: "请解释 context.Context 的用途。",
  rubric: [
    {
      id: "go.context.cancel",
      description: "说明取消传播",
      weight: 60,
    },
    {
      id: "go.context.deadline",
      description: "说明截止时间",
      weight: 40,
    },
  ],
  followUpGoals: [
    {
      id: "go.context.clarify",
      kind: "clarification",
      goal: "澄清取消传播范围",
    },
    {
      id: "go.context.depth",
      kind: "depth",
      goal: "解释 Value 的使用边界",
    },
  ],
  knowledgeExplanation: "Context 传递取消、截止时间和请求范围值。",
  active: true,
};

const modelMetadata = {
  provider: "faux",
  modelId: "faux-v1",
  promptVersion: "evaluation-v1",
  schemaVersion: "1.0",
  questionVersion: 7,
  purpose: "answer_evaluation",
  latencyMs: 12,
  inputTokens: 20,
  outputTokens: 10,
};

const trustedEvaluationContext = {
  evaluationId: "evaluation-1",
  expectedQuestionVersion: 7,
  expectedPurpose: "answer_evaluation",
  metadata: modelMetadata,
} as const;

function makeDefinition(index = 1): QuestionDefinition {
  const definition = mapQuestionBankQuestionDtoToDefinition({
    ...questionBankQuestion,
    id: `go.question.${index}`,
    rubric: questionBankQuestion.rubric.map((item, itemIndex) => ({
      ...item,
      id: `go.question.${index}.rubric.${itemIndex + 1}`,
    })),
    followUpGoals: questionBankQuestion.followUpGoals.map((goal, goalIndex) => ({
      ...goal,
      id: `go.question.${index}.goal.${goalIndex + 1}`,
    })),
  });
  return definition;
}

function makeInterview(changes: Partial<Interview> = {}): Interview {
  const definitions = Array.from({ length: 5 }, (_, index) => makeDefinition(index + 1));
  const blueprint = {
    selectionSeed: "seed-1",
    questions: definitions.map((definition, index) => ({
      position: index + 1,
      question: mapQuestionDefinitionToSnapshot(
        definition,
        `第 ${index + 1} 题：${definition.sourceWording}`,
      ),
    })),
  };
  const createdAt = new Date(occurredAt);
  return {
    id: parseInterviewId("interview-1"),
    accountId: parseAccountId("account-1"),
    version: 3,
    status: "active",
    phase: "awaiting_response",
    questionCount: 5,
    blueprint,
    currentQuestionPosition: 1,
    questions: blueprint.questions.map((item) => ({
      position: item.position,
      answerMaterial: [],
      questionClarifications: [],
      systemFollowUps: [],
      evaluation: null,
      outcome: null,
      frozen: false,
    })),
    pendingOperation: null,
    pendingReportKind: null,
    reportRequestedAt: null,
    reportId: null,
    createdAt,
    lastEffectiveActivityAt: createdAt,
    ...changes,
  };
}

const responseContext = {
  messages: [
    {
      id: parseMessageId("message-1"),
      role: "interviewer",
      kind: "main_question",
      text: "请解释 context.Context 的用途。",
      createdAt: new Date(occurredAt),
    },
  ],
  operation: null,
  endedAt: null,
} as const;

describe("command mappings", () => {
  const baseContext = {
    interviewId: "interview-1",
    operationId: "operation-1",
    occurredAt,
  };

  it("maps create, answer, supplement, control, and retry variants explicitly", () => {
    const interview = makeInterview();
    expect(
      mapCreateInterviewCommand(
        { questionCount: 5, expectedVersion: 0 },
        {
          ...baseContext,
          accountId: "account-1",
          blueprint: interview.blueprint,
        },
      ),
    ).toMatchObject({
      type: "create_interview",
      interviewId: "interview-1",
      accountId: "account-1",
      operationId: "operation-1",
      expectedVersion: 0,
      questionCount: 5,
    });

    expect(
      mapSubmitAnswerCommand(
        { expectedVersion: 3, text: "answer" },
        { ...baseContext, answerMaterialId: "answer-1" },
      ),
    ).toMatchObject({
      type: "submit_answer",
      answerMaterialId: "answer-1",
      text: "answer",
    });
    expect(
      mapSubmitSupplementCommand(
        { expectedVersion: 3, text: "supplement" },
        { ...baseContext, answerMaterialId: "answer-2" },
      ),
    ).toMatchObject({
      type: "submit_supplement",
      answerMaterialId: "answer-2",
      text: "supplement",
    });

    const variants = [
      mapRequestQuestionClarificationCommand({ expectedVersion: 3 }, baseContext),
      mapMarkQuestionUnknownCommand({ expectedVersion: 3 }, baseContext),
      mapSkipQuestionCommand({ expectedVersion: 3 }, baseContext),
      mapContinueInterviewCommand({ expectedVersion: 3 }, baseContext),
      mapEndInterviewEarlyCommand({ expectedVersion: 3 }, baseContext),
      mapAbandonInterviewCommand({ expectedVersion: 3 }, baseContext),
    ];
    expect(variants.map((command) => command.type)).toEqual([
      "request_question_clarification",
      "mark_question_unknown",
      "skip_question",
      "continue_interview",
      "end_interview_early",
      "abandon_interview",
    ]);
    expect(
      variants.every((command) => command.occurredAt.getTime() === Date.parse(occurredAt)),
    ).toBe(true);

    expect(
      mapRetryOperationInput(
        { expectedVersion: 3, operationId: "failed-operation-1" },
        { ...baseContext, operationId: "retry-operation-1" },
      ),
    ).toMatchObject({
      interviewId: "interview-1",
      operationId: "retry-operation-1",
      failedOperationId: "failed-operation-1",
      expectedVersion: 3,
    });
  });

  it("rejects untrusted DTOs before mapping and parses trusted IDs/timestamps", () => {
    expect(() =>
      mapSubmitAnswerCommand(
        { expectedVersion: 3, text: "   " },
        { ...baseContext, answerMaterialId: "answer-1" },
      ),
    ).toThrow(ContractMappingError);
    expect(() =>
      mapSkipQuestionCommand({ expectedVersion: 3 }, { ...baseContext, interviewId: "invalid id" }),
    ).toThrow("Invalid InterviewId");
    expect(() =>
      mapSkipQuestionCommand(
        { expectedVersion: 3 },
        { ...baseContext, occurredAt: "not-a-timestamp" },
      ),
    ).toThrow(ContractMappingError);
    expect(() =>
      mapSkipQuestionCommand(
        { expectedVersion: 3 },
        { ...baseContext, occurredAt: "August 9, 2026" },
      ),
    ).toThrow(ContractMappingError);
  });
});

describe("question-bank mappings", () => {
  it("round-trips exact versions, Rubrics, goals, and immutable snapshot content", () => {
    const definition = mapQuestionBankQuestionDtoToDefinition(questionBankQuestion);
    expect(mapQuestionDefinitionToQuestionBankDto(definition)).toEqual(questionBankQuestion);

    const snapshot = mapQuestionDefinitionToSnapshot(definition, "请说明 Context 的主要用途。");
    const persisted = mapQuestionSnapshotToInternalDto(snapshot);
    expect(Check(InternalQuestionSnapshotSchema, persisted)).toBe(true);
    expect(persisted).toMatchObject({
      questionId: questionBankQuestion.id,
      questionVersion: 7,
      displayedWording: "请说明 Context 的主要用途。",
      rubric: questionBankQuestion.rubric,
      followUpGoals: questionBankQuestion.followUpGoals,
    });
    expect(mapInternalQuestionSnapshotDtoToDomain(persisted)).toEqual(snapshot);
  });

  it("rejects invalid identifiers and semantically invalid Rubrics", () => {
    expect(() =>
      mapQuestionBankQuestionDtoToDefinition({ ...questionBankQuestion, id: "bad id" }),
    ).toThrow(ContractMappingError);
    expect(() =>
      mapQuestionBankQuestionDtoToDefinition({
        ...questionBankQuestion,
        rubric: questionBankQuestion.rubric.map((item) => ({ ...item, weight: 30 })),
      }),
    ).toThrow(ContractMappingError);
  });

  it("trim-aware rejects blank content without normalizing preserved wording", () => {
    const preserved = mapQuestionBankQuestionDtoToDefinition({
      ...questionBankQuestion,
      sourceWording: "  保留首尾空格  ",
    });
    expect(preserved.sourceWording).toBe("  保留首尾空格  ");

    for (const invalid of [
      { ...questionBankQuestion, sourceWording: " \n\t " },
      {
        ...questionBankQuestion,
        rubric: [{ ...questionBankQuestion.rubric[0], description: "   ", weight: 100 }],
      },
      {
        ...questionBankQuestion,
        followUpGoals: [{ ...questionBankQuestion.followUpGoals[0], goal: "\t" }],
      },
      { ...questionBankQuestion, knowledgeExplanation: "\n " },
    ]) {
      expect(() => mapQuestionBankQuestionDtoToDefinition(invalid)).toThrow(ContractMappingError);
    }

    const snapshot = mapQuestionDefinitionToSnapshot(preserved, "  展示措辞  ");
    expect(snapshot.displayedWording).toBe("  展示措辞  ");
    expect(() => mapQuestionDefinitionToSnapshot(preserved, " \t ")).toThrow(ContractMappingError);
    expect(() =>
      mapInternalQuestionSnapshotDtoToDomain({
        ...mapQuestionSnapshotToInternalDto(snapshot),
        knowledgeExplanation: "   ",
      }),
    ).toThrow(ContractMappingError);
  });
});

describe("evaluation mappings", () => {
  const structuredEvaluation = {
    classification: "relevant",
    rubricItems: [
      {
        rubricItemId: "go.context.cancel",
        evidenceMaterialIds: ["answer-1"],
        awardedPoints: 60,
        missingOrIncorrectPoints: [],
      },
      {
        rubricItemId: "go.context.deadline",
        evidenceMaterialIds: ["answer-1"],
        awardedPoints: 10,
        missingOrIncorrectPoints: ["未完整说明截止时间传播"],
      },
    ],
    recommendedFollowUp: {
      goalId: "go.context.depth",
      kind: "depth",
      purpose: "depth",
    },
    metadata: {
      provider: modelMetadata.provider,
      modelId: modelMetadata.modelId,
      promptVersion: modelMetadata.promptVersion,
      schemaVersion: modelMetadata.schemaVersion,
      questionVersion: modelMetadata.questionVersion,
      purpose: modelMetadata.purpose,
      latencyMs: modelMetadata.latencyMs,
      tokens: {
        inputTokens: modelMetadata.inputTokens,
        outputTokens: modelMetadata.outputTokens,
      },
    },
  };

  it("maps model facts and derives the final score only in the domain", () => {
    const mapped = mapStructuredAnswerEvaluationDto(structuredEvaluation, trustedEvaluationContext);
    const final = scoreQuestion({
      rubric: mapQuestionBankQuestionDtoToDefinition(questionBankQuestion).rubric,
      evaluation: mapped.evaluation,
      validEvidenceMaterialIds: new Set([parseAnswerMaterialId("answer-1")]),
    });
    expect(final.outcome).toEqual({ kind: "scored", score: 70 });

    const persisted = mapQuestionEvaluationToInternalDto(final, trustedEvaluationContext);
    expect(Check(InternalQuestionEvaluationSchema, persisted)).toBe(true);
    expect(persisted.outcome).toEqual({ kind: "scored", score: 70 });
  });

  it("rejects a model-supplied total score and invalid evidence IDs", () => {
    expect(() =>
      mapStructuredAnswerEvaluationDto(
        { ...structuredEvaluation, totalScore: 100 },
        trustedEvaluationContext,
      ),
    ).toThrow(ContractMappingError);
    expect(() =>
      mapStructuredAnswerEvaluationDto(
        {
          ...structuredEvaluation,
          rubricItems: [
            {
              ...structuredEvaluation.rubricItems[0],
              evidenceMaterialIds: ["bad id"],
            },
          ],
        },
        trustedEvaluationContext,
      ),
    ).toThrow(ContractMappingError);
  });

  it("binds audit metadata to trusted question version and evaluation purpose", () => {
    const spoofed = mapStructuredAnswerEvaluationDto(
      {
        ...structuredEvaluation,
        metadata: {
          ...structuredEvaluation.metadata,
          provider: "attacker-controlled",
          modelId: "spoofed",
        },
      },
      trustedEvaluationContext,
    );
    expect(spoofed.metadata).toEqual(modelMetadata);

    for (const metadata of [
      { ...structuredEvaluation.metadata, questionVersion: 8 },
      { ...structuredEvaluation.metadata, purpose: "report_analysis" },
    ]) {
      expect(() =>
        mapStructuredAnswerEvaluationDto(
          { ...structuredEvaluation, metadata },
          trustedEvaluationContext,
        ),
      ).toThrow(ContractMappingError);
    }

    const mapped = mapStructuredAnswerEvaluationDto(structuredEvaluation, trustedEvaluationContext);
    const final = scoreQuestion({
      rubric: mapQuestionBankQuestionDtoToDefinition(questionBankQuestion).rubric,
      evaluation: mapped.evaluation,
      validEvidenceMaterialIds: new Set([parseAnswerMaterialId("answer-1")]),
    });
    for (const metadata of [
      { ...modelMetadata, questionVersion: 999 },
      { ...modelMetadata, purpose: "report_analysis" },
    ]) {
      expect(() =>
        mapQuestionEvaluationToInternalDto(final, {
          expectedQuestionVersion: 7,
          expectedPurpose: "answer_evaluation",
          metadata,
        }),
      ).toThrow(ContractMappingError);
    }
  });
});

describe("interview response mappings", () => {
  it("maps every lifecycle discriminator and allowed Operation state", () => {
    const active = mapInterviewToResponse(makeInterview(), responseContext);
    expect(active).toMatchObject({ status: "active", phase: "awaiting_response" });

    const processing = mapInterviewToResponse(
      makeInterview({
        phase: "processing",
        pendingOperation: {
          operationId: parseOperationId("operation-1"),
          operation: "answer_analysis",
          questionPosition: 1,
          acceptedAt: new Date(occurredAt),
          previousPhase: "awaiting_response",
        },
      }),
      responseContext,
    );
    expect(processing).toMatchObject({
      status: "active",
      phase: "processing",
      operation: { operationId: "operation-1", status: "processing" },
      availableActions: [],
    });

    const answeredQuestions = makeInterview().questions.map((question, index) =>
      index === 0 ? { ...question, outcome: createZeroQuestionOutcome("unknown") } : question,
    );
    const awaitingContinue = mapInterviewToResponse(
      makeInterview({ phase: "awaiting_continue", questions: answeredQuestions }),
      {
        ...responseContext,
        operation: {
          operationId: parseOperationId("operation-failed"),
          status: "failed",
          failure: {
            code: "model_failure",
            message: "Temporarily unavailable",
            retryable: true,
          },
        },
      },
    );
    expect(awaitingContinue).toMatchObject({
      status: "active",
      phase: "awaiting_continue",
      availableActions: expect.arrayContaining(["submit_supplement", "continue", "retry"]),
    });

    const reportPending = mapInterviewToResponse(
      makeInterview({
        status: "report_pending",
        phase: null,
        pendingReportKind: "complete",
        reportRequestedAt: later,
      }),
      {
        ...responseContext,
        operation: {
          operationId: parseOperationId("operation-report"),
          status: "processing",
        },
      },
    );
    expect(reportPending).toMatchObject({
      status: "report_pending",
      reportKind: "complete",
      availableActions: [],
    });

    const terminalCases = [
      makeInterview({
        status: "completed",
        phase: null,
        reportId: parseReportId("report-1"),
      }),
      makeInterview({
        status: "early_ended",
        phase: null,
        reportId: parseReportId("report-2"),
      }),
      makeInterview({ status: "abandoned", phase: null }),
      makeInterview({ status: "deleting", phase: null }),
    ];
    const terminalResponses = terminalCases.map((interview) =>
      mapInterviewToResponse(interview, { ...responseContext, endedAt: later }),
    );
    expect(terminalResponses.map((response) => response.status)).toEqual([
      "completed",
      "early_ended",
      "abandoned",
      "deleting",
    ]);
    expect(
      terminalResponses.every((response) => Check(InterviewDetailResponseSchema, response)),
    ).toBe(true);
  });

  it("does not leak active Rubrics, domains, explanations, allowances, or scores", () => {
    const response = mapInterviewToResponse(makeInterview(), responseContext);
    const serialized = JSON.stringify(response);
    for (const forbidden of [
      "rubric",
      "go_language",
      "knowledgeExplanation",
      "followUpGoals",
      "remainingFollowUp",
      "score",
      "Context 传递取消、截止时间和请求范围值",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("rejects invalid lifecycle context and dates", () => {
    expect(() =>
      mapInterviewToResponse(
        makeInterview({ status: "completed", phase: null, reportId: parseReportId("report-1") }),
        responseContext,
      ),
    ).toThrow(ContractMappingError);
    expect(() =>
      mapInterviewToResponse(makeInterview({ createdAt: new Date("invalid") }), responseContext),
    ).toThrow(ContractMappingError);
  });

  it("rejects impossible active and terminal chronology", () => {
    const completed = makeInterview({
      status: "completed",
      phase: null,
      reportId: parseReportId("report-1"),
      lastEffectiveActivityAt: later,
    });
    expect(() =>
      mapInterviewToResponse(completed, {
        ...responseContext,
        endedAt: new Date("2026-08-09T12:30:00.000Z"),
      }),
    ).toThrow(ContractMappingError);
    expect(() =>
      mapInterviewToResponse(
        makeInterview({
          status: "completed",
          phase: null,
          reportId: parseReportId("report-1"),
        }),
        {
          ...responseContext,
          messages: [
            {
              ...responseContext.messages[0],
              createdAt: new Date("2026-08-09T14:00:00.000Z"),
            },
          ],
          endedAt: later,
        },
      ),
    ).toThrow(ContractMappingError);
    expect(() =>
      mapInterviewToResponse(makeInterview(), {
        ...responseContext,
        messages: [
          {
            ...responseContext.messages[0],
            createdAt: new Date("2026-08-09T11:59:59.000Z"),
          },
        ],
      }),
    ).toThrow(ContractMappingError);
    expect(() =>
      mapInterviewToResponse(makeInterview(), {
        ...responseContext,
        messages: [
          { ...responseContext.messages[0], createdAt: later },
          { ...responseContext.messages[0], id: parseMessageId("message-2") },
        ],
      }),
    ).toThrow(ContractMappingError);
  });

  it("bounds user activity by last activity and every message by expiry", () => {
    expect(() =>
      mapInterviewToResponse(makeInterview(), {
        ...responseContext,
        messages: [
          ...responseContext.messages,
          {
            id: parseMessageId("message-answer-late"),
            role: "user",
            kind: "answer",
            text: "迟到的回答",
            createdAt: later,
          },
        ],
      }),
    ).toThrow(ContractMappingError);

    expect(
      mapInterviewToResponse(makeInterview(), {
        ...responseContext,
        messages: [
          ...responseContext.messages,
          {
            id: parseMessageId("message-follow-up-late"),
            role: "interviewer",
            kind: "follow_up",
            text: "系统追问",
            createdAt: later,
          },
        ],
      }),
    ).toMatchObject({ status: "active" });

    expect(() =>
      mapInterviewToResponse(makeInterview(), {
        ...responseContext,
        messages: [
          ...responseContext.messages,
          {
            id: parseMessageId("message-after-expiry"),
            role: "user",
            kind: "answer",
            text: "超过截止时间的回答",
            createdAt: new Date("2026-08-10T12:00:00.001Z"),
          },
        ],
      }),
    ).toThrow(ContractMappingError);
  });
});

describe("score and report mappings", () => {
  it.each([
    ["unknown", createZeroQuestionOutcome("unknown")],
    ["skipped", createZeroQuestionOutcome("skipped")],
    ["irrelevant", createZeroQuestionOutcome("irrelevant")],
    ["incorrect", createZeroQuestionOutcome("incorrect")],
  ] as const)("preserves the %s zero outcome reason", (reason, outcome) => {
    expect(mapQuestionOutcomeToDto(outcome)).toEqual({
      outcome: reason,
      score: 0,
      zeroScoreReason: reason,
    });
  });

  it("maps deterministic complete scoring including an all-zero result", () => {
    const questions: readonly SelectedQuestionScore[] = Array.from({ length: 5 }, (_, index) => ({
      domain: makeDefinition(index + 1).domain,
      outcome: createZeroQuestionOutcome("unknown"),
    }));
    const score = aggregateCompleteInterviewScore(questions, 5);
    expect(mapCompleteInterviewScoreToDto(score).overallScore).toBe(0);
  });

  it("sanitizes internal immutable reports into public DTOs", () => {
    const domains = [
      "go_language",
      "concurrency_runtime_performance",
      "http_rpc_api",
      "database_storage",
      "cache_messaging_distributed",
      "testing_observability_engineering",
    ].map((domain, index) =>
      index < 5
        ? { status: "assessed", domain, score: 80, questionCount: 1 }
        : { status: "unassessed", domain },
    );
    const questions = Array.from({ length: 5 }, (_, index) => ({
      questionId: `question-${index + 1}`,
      questionVersion: 7,
      domain: domains[index]?.domain,
      position: index + 1,
      displayedQuestion: `问题 ${index + 1}`,
      answerSummary: "回答摘要",
      outcome: "scored",
      score: 80,
      matchedKnowledgePoints: [
        {
          rubricItemId: `rubric-${index + 1}`,
          summary: "匹配知识点",
          awardedPoints: 80,
          evidence: [{ source: "answer_material", answerMaterialId: `answer-${index + 1}` }],
        },
      ],
      missingOrIncorrectPoints: [
        {
          rubricItemId: `rubric-missing-${index + 1}`,
          summary: "缺失知识点",
          awardedPoints: 0,
          evidence: [{ source: "question_snapshot", questionId: `question-${index + 1}` }],
        },
      ],
      scoreRationale: "评分理由",
      improvementSuggestions: ["改进建议"],
      evidence: [{ source: "answer_material", answerMaterialId: `answer-${index + 1}` }],
    }));
    const internal = {
      kind: "complete",
      reportId: "report-1",
      interviewId: "interview-1",
      generatedAt: occurredAt,
      overallExplanation: "总体说明",
      strengths: ["优势"],
      weaknesses: ["不足"],
      priorities: ["优先项"],
      learningSuggestions: ["学习建议"],
      schemaVersion: "1.0",
      modelMetadata: {
        provider: modelMetadata.provider,
        modelId: modelMetadata.modelId,
        promptVersion: modelMetadata.promptVersion,
        schemaVersion: modelMetadata.schemaVersion,
        questionVersion: modelMetadata.questionVersion,
        purpose: modelMetadata.purpose,
        latencyMs: modelMetadata.latencyMs,
        tokens: {
          inputTokens: modelMetadata.inputTokens,
          outputTokens: modelMetadata.outputTokens,
        },
      },
      questionVersions: questions.map((question) => ({
        questionId: question.questionId,
        questionVersion: question.questionVersion,
      })),
      domains,
      questions,
      overallScore: 80,
    };
    const publicReport = mapInternalReportSnapshotToPublic(internal);
    expect(Check(ReportResponseSchema, publicReport)).toBe(true);
    const serialized = JSON.stringify(publicReport);
    for (const forbidden of [
      "questionId",
      "questionVersion",
      "rubricItemId",
      "awardedPoints",
      "evidence",
      "modelMetadata",
      "schemaVersion",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    expect(() =>
      mapInternalReportSnapshotToPublic({
        ...internal,
        questions: questions.map((question) => ({ ...question, score: 1 })),
        domains: domains.map((result) =>
          result.status === "assessed" ? { ...result, score: 100 } : result,
        ),
        overallScore: 100,
      }),
    ).toThrow(ContractMappingError);

    expect(() =>
      mapInternalReportSnapshotToPublic({
        ...internal,
        questions: questions.map((question, index) =>
          index === 0
            ? {
                ...question,
                score: 100,
                matchedKnowledgePoints: [
                  {
                    rubricItemId: "rubric-1",
                    summary: "匹配知识点",
                    awardedPoints: 50,
                    evidence: [{ source: "answer_material", answerMaterialId: "answer-1" }],
                  },
                  {
                    rubricItemId: "rubric-1",
                    summary: "重复匹配知识点",
                    awardedPoints: 50,
                    evidence: [{ source: "answer_material", answerMaterialId: "answer-1" }],
                  },
                ],
              }
            : question,
        ),
      }),
    ).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "duplicate_rubric_award" }),
        ]),
      }),
    );

    const { overallScore, ...internalWithoutOverallScore } = internal;
    expect(overallScore).toBe(80);
    const incompleteReport = mapInternalReportSnapshotToPublic({
      ...internalWithoutOverallScore,
      kind: "incomplete",
      domains: [
        { status: "assessed", domain: "go_language", score: 80, questionCount: 1 },
        ...domains.slice(1).map((result) => ({
          status: "unassessed",
          domain: result.domain,
        })),
      ],
      questions: questions.slice(0, 1),
      questionVersions: internal.questionVersions.slice(0, 1),
    });
    expect(incompleteReport.kind).toBe("incomplete");
    expect("overallScore" in incompleteReport).toBe(false);
  });
});

describe("error mappings", () => {
  it("maps version conflicts to stable, sanitized envelopes", () => {
    const envelope = mapDomainErrorToEnvelope(
      new InterviewVersionConflictError(2, 3),
      parseInterviewId("interview-1"),
    );
    expect(Check(ErrorEnvelopeSchema, envelope)).toBe(true);
    expect(envelope).toEqual({
      error: {
        code: "version_conflict",
        message: "Interview state changed; reload the canonical state and retry.",
        interviewId: "interview-1",
        currentVersion: 3,
      },
    });
    expect(JSON.stringify(envelope)).not.toContain("stack");
  });

  it("does not expose domain details, secrets, or unknown error messages", () => {
    const domainEnvelope = mapDomainErrorToEnvelope(
      new InterviewDomainError("invalid_interview_command", "secret answer contents"),
    );
    const unknownEnvelope = mapDomainErrorToEnvelope(new Error("token=super-secret"));
    expect(JSON.stringify(domainEnvelope)).not.toContain("secret answer contents");
    expect(domainEnvelope.error.code).toBe("internal_error");
    expect(JSON.stringify(unknownEnvelope)).not.toContain("super-secret");
    expect(unknownEnvelope).toEqual({
      error: {
        code: "internal_error",
        message: "An unexpected error occurred.",
      },
    });
  });

  it("exposes only safe inbound issues and sanitizes internal mapping failures", () => {
    let inboundError: unknown;
    try {
      mapSubmitAnswerCommand(
        { expectedVersion: 3, text: "   " },
        {
          interviewId: "interview-1",
          operationId: "operation-1",
          occurredAt,
          answerMaterialId: "answer-1",
        },
      );
    } catch (error) {
      inboundError = error;
    }
    expect(mapDomainErrorToEnvelope(inboundError).error.code).toBe("validation_error");

    let internalError: unknown;
    try {
      mapInternalQuestionSnapshotDtoToDomain({
        ...mapQuestionSnapshotToInternalDto(mapQuestionDefinitionToSnapshot(makeDefinition())),
        rubric: [
          {
            id: "secret-rubric-id",
            description: " ",
            weight: 100,
          },
        ],
      });
    } catch (error) {
      internalError = error;
    }
    const envelope = mapDomainErrorToEnvelope(internalError);
    expect(envelope).toEqual({
      error: {
        code: "internal_error",
        message: "An unexpected error occurred.",
      },
    });
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain("secret-rubric-id");
    expect(serialized).not.toContain("rubric");
    expect(serialized).not.toContain("stack");

    let responseError: unknown;
    try {
      mapInterviewToResponse(makeInterview(), {
        ...responseContext,
        messages: [
          {
            ...responseContext.messages[0],
            text: "secret transcript contents",
            createdAt: new Date("invalid"),
          },
        ],
      });
    } catch (error) {
      responseError = error;
    }
    const responseEnvelope = mapDomainErrorToEnvelope(responseError);
    expect(responseEnvelope.error.code).toBe("internal_error");
    expect(JSON.stringify(responseEnvelope)).not.toContain("secret transcript contents");
  });
});
