import { describe, expect, it } from "vitest";

import {
  type AnswerAnalysisPlan,
  cancelInterviewOperation,
  completeInterviewOperation,
  getCurrentQuestion,
  getInterviewProgress,
  handleInterviewCommand,
  type Interview,
  type InterviewBlueprint,
  InterviewIdMismatchError,
  type InterviewOperationPlan,
  type InterviewQuestionCount,
  type InterviewTransition,
  InterviewVersionConflictError,
  InvalidInterviewBlueprintError,
  InvalidInterviewCommandError,
  isInterviewExpired,
  KNOWLEDGE_DOMAINS,
  parseAccountId,
  parseAnswerMaterialId,
  parseEvaluationId,
  parseFollowUpGoalId,
  parseInterviewId,
  parseMessageId,
  parseOperationId,
  parseQuestionId,
  parseReportId,
  parseRubricItemId,
  type QuestionEvaluation,
  type RecordQuestionEvaluationCommand,
  type RecordSystemFollowUpCommand,
} from "../src/index.js";

const STARTED_AT = new Date("2026-08-01T00:00:00.000Z");
let sequence = 0;

function nextOperationId() {
  sequence += 1;
  return parseOperationId(`operation-${sequence}`);
}

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Expected test fixture value");
  }
  return value;
}

function blueprint(questionCount: InterviewQuestionCount = 5): InterviewBlueprint {
  return {
    selectionSeed: "fixed-seed",
    unassessedDomain: questionCount === 5 ? "testing_observability_engineering" : null,
    questions: Array.from({ length: questionCount }, (_, index) => {
      const number = index + 1;
      const domain = KNOWLEDGE_DOMAINS[index % KNOWLEDGE_DOMAINS.length];
      if (domain === undefined) {
        throw new Error("Expected a knowledge-domain fixture");
      }
      return {
        position: number,
        question: {
          questionId: parseQuestionId(`question-${number}`),
          questionVersion: 1,
          domain,
          sourceWording: `Source question ${number}`,
          displayedWording: `Displayed question ${number}`,
          rubric: [
            {
              id: parseRubricItemId(`rubric-${number}`),
              description: "Required point",
              weight: 100,
            },
          ],
          followUpGoals: [
            {
              id: parseFollowUpGoalId(`clarification-${number}-a`),
              kind: "clarification",
              goal: "Clarify the answer",
            },
            {
              id: parseFollowUpGoalId(`clarification-${number}-b`),
              kind: "clarification",
              goal: "Clarify another aspect",
            },
            {
              id: parseFollowUpGoalId(`depth-${number}-a`),
              kind: "depth",
              goal: "Explore depth",
            },
            {
              id: parseFollowUpGoalId(`depth-${number}-b`),
              kind: "depth",
              goal: "Explore more depth",
            },
          ],
          knowledgeExplanation: "Internal explanation",
        },
      };
    }),
  };
}

function createInterview(
  inputBlueprint: InterviewBlueprint = blueprint(),
  occurredAt: Date = STARTED_AT,
): Interview {
  return expectTransition(
    handleInterviewCommand(null, {
      type: "create_interview",
      interviewId: parseInterviewId("interview-1"),
      accountId: parseAccountId("account-1"),
      operationId: nextOperationId(),
      expectedVersion: 0,
      occurredAt,
      questionCount: inputBlueprint.questions.length as InterviewQuestionCount,
      blueprint: inputBlueprint,
    }),
  ).interview;
}

function expectTransition(result: ReturnType<typeof handleInterviewCommand>): InterviewTransition {
  expect(result.kind).toBe("transition");
  if (result.kind !== "transition") {
    throw new Error("Expected an immediate transition");
  }
  return result;
}

function expectPlan(result: ReturnType<typeof handleInterviewCommand>): InterviewOperationPlan {
  expect(result.kind).toBe("operation_plan");
  if (result.kind !== "operation_plan") {
    throw new Error("Expected an Operation plan");
  }
  return result;
}

function submitAnswerPlan(
  interview: Interview,
  text = "An answer",
  occurredAt = new Date(interview.lastEffectiveActivityAt.getTime() + 1_000),
): AnswerAnalysisPlan {
  const plan = expectPlan(
    handleInterviewCommand(interview, {
      type: "submit_answer",
      interviewId: interview.id,
      operationId: nextOperationId(),
      expectedVersion: interview.version,
      occurredAt,
      answerMaterialId: parseAnswerMaterialId(`material-${sequence}`),
      text,
    }),
  );
  if (plan.operation !== "answer_analysis") {
    throw new Error("Expected an answer-analysis Operation plan");
  }
  return plan;
}

function submitSupplementPlan(
  interview: Interview,
  text = "A supplement",
  occurredAt = new Date(interview.lastEffectiveActivityAt.getTime() + 1_000),
): AnswerAnalysisPlan {
  const plan = expectPlan(
    handleInterviewCommand(interview, {
      type: "submit_supplement",
      interviewId: interview.id,
      operationId: nextOperationId(),
      expectedVersion: interview.version,
      occurredAt,
      answerMaterialId: parseAnswerMaterialId(`material-${sequence}`),
      text,
    }),
  );
  if (plan.operation !== "answer_analysis") {
    throw new Error("Expected an answer-analysis Operation plan");
  }
  return plan;
}

function evaluation(
  plan: InterviewOperationPlan,
  score: number,
  classification: "relevant" | "ambiguous" | "irrelevant" = "relevant",
): Omit<QuestionEvaluation, "outcome"> {
  if (plan.operation !== "answer_analysis") {
    throw new Error("Expected answer analysis plan");
  }
  const rubricItemId = parseRubricItemId(`rubric-${plan.questionPosition}`);
  const rubricItems = [
    {
      rubricItemId,
      evidenceMaterialIds: score > 0 ? [plan.material.id] : [],
      awardedPoints: score,
      missingOrIncorrectPoints: score === 100 ? [] : ["Missing point"],
    },
  ];

  return {
    id: parseEvaluationId(`evaluation-${sequence}`),
    classification,
    rubricItems,
  };
}

function evaluationCompletion(
  _interview: Interview,
  plan: InterviewOperationPlan,
  score: number,
  classification: "relevant" | "ambiguous" | "irrelevant" = "relevant",
  occurredAt = new Date(plan.acceptedAt.getTime() + 10_000),
): RecordQuestionEvaluationCommand {
  return {
    type: "record_question_evaluation",
    interviewId: plan.interview.id,
    operationId: plan.operationId,
    expectedVersion: plan.interview.version,
    occurredAt,
    evaluation: evaluation(plan, score, classification),
  };
}

function followUpCompletion(
  _interview: Interview,
  plan: InterviewOperationPlan,
  input: {
    kind: "clarification" | "depth";
    purpose: "answer_clarification" | "irrelevant_response_clarification" | "depth";
    classification?: "relevant" | "ambiguous" | "irrelevant";
    suffix?: "a" | "b";
  },
): RecordSystemFollowUpCommand {
  return {
    type: "record_system_follow_up",
    interviewId: plan.interview.id,
    operationId: plan.operationId,
    expectedVersion: plan.interview.version,
    occurredAt: new Date(plan.acceptedAt.getTime() + 10_000),
    messageId: parseMessageId(`message-${sequence}`),
    goalId: parseFollowUpGoalId(`${input.kind}-${plan.questionPosition}-${input.suffix ?? "a"}`),
    kind: input.kind,
    purpose: input.purpose,
    responseClassification: input.classification ?? "relevant",
    text: "Please expand your answer",
  };
}

function completeEvaluation(
  _interview: Interview,
  plan: InterviewOperationPlan,
  score: number,
  classification: "relevant" | "ambiguous" | "irrelevant" = "relevant",
): Interview {
  return completeInterviewOperation(
    plan.interview,
    plan,
    evaluationCompletion(plan.interview, plan, score, classification),
  ).interview;
}

function markOutcome(
  interview: Interview,
  type: "mark_question_unknown" | "skip_question" = "skip_question",
  occurredAt = new Date(interview.lastEffectiveActivityAt.getTime() + 1_000),
): Interview {
  return expectTransition(
    handleInterviewCommand(interview, {
      type,
      interviewId: interview.id,
      operationId: nextOperationId(),
      expectedVersion: interview.version,
      occurredAt,
    }),
  ).interview;
}

function continueInterview(
  interview: Interview,
  occurredAt = new Date(interview.lastEffectiveActivityAt.getTime() + 1_000),
): InterviewTransition {
  return expectTransition(
    handleInterviewCommand(interview, {
      type: "continue_interview",
      interviewId: interview.id,
      operationId: nextOperationId(),
      expectedVersion: interview.version,
      occurredAt,
    }),
  );
}

describe("interview creation", () => {
  it("freezes a complete blueprint and starts with 1-based progress on one current question", () => {
    const input = blueprint();
    const interview = createInterview(input);

    expect(interview).toMatchObject({
      version: 1,
      status: "active",
      phase: "awaiting_response",
      currentQuestionPosition: 1,
      questionCount: 5,
    });
    expect(getInterviewProgress(interview)).toEqual({ current: 1, total: 5 });
    expect(getCurrentQuestion(interview).questionId).toBe(parseQuestionId("question-1"));
    expect(Object.isFrozen(interview.blueprint)).toBe(true);
    expect(Object.isFrozen(interview.blueprint.questions[0]?.question.rubric)).toBe(true);

    Reflect.set(required(input.questions[0]).question, "displayedWording", "Mutated outside");
    expect(getCurrentQuestion(interview).displayedWording).toBe("Displayed question 1");
  });

  it.each([
    {
      name: "missing question",
      makeInvalid: () => {
        const value = blueprint();
        return { ...value, questions: value.questions.slice(0, -1) };
      },
    },
    {
      name: "non-contiguous position",
      makeInvalid: () => {
        const value = blueprint();
        return {
          ...value,
          questions: value.questions.map((item, index) =>
            index === 1 ? { ...item, position: 4 } : item,
          ),
        };
      },
    },
    {
      name: "invalid Rubric total",
      makeInvalid: () => {
        const value = blueprint();
        return {
          ...value,
          questions: value.questions.map((item, index) =>
            index === 0
              ? {
                  ...item,
                  question: {
                    ...item.question,
                    rubric: item.question.rubric.map((rubricItem) => ({
                      ...rubricItem,
                      weight: 99,
                    })),
                  },
                }
              : item,
          ),
        };
      },
    },
    {
      name: "duplicate question",
      makeInvalid: () => {
        const value = blueprint();
        const duplicateId = required(value.questions[0]).question.questionId;
        return {
          ...value,
          questions: value.questions.map((item, index) =>
            index === 1
              ? { ...item, question: { ...item.question, questionId: duplicateId } }
              : item,
          ),
        };
      },
    },
    {
      name: "invalid domain coverage",
      makeInvalid: () => {
        const value = blueprint();
        return {
          ...value,
          questions: value.questions.map((item) => ({
            ...item,
            question: { ...item.question, domain: "go_language" as const },
          })),
        };
      },
    },
    {
      name: "mismatched unassessed domain",
      makeInvalid: () => ({
        ...blueprint(),
        unassessedDomain: "cache_messaging_distributed" as const,
      }),
    },
    {
      name: "missing clarification goal",
      makeInvalid: () => {
        const value = blueprint();
        return {
          ...value,
          questions: value.questions.map((item, index) =>
            index === 0
              ? {
                  ...item,
                  question: {
                    ...item.question,
                    followUpGoals: item.question.followUpGoals.filter(
                      (goal) => goal.kind === "depth",
                    ),
                  },
                }
              : item,
          ),
        };
      },
    },
  ])("rejects a blueprint with $name", ({ makeInvalid }) => {
    expect(() => createInterview(makeInvalid())).toThrow(InvalidInterviewBlueprintError);
  });
});

describe("answer processing and clarification", () => {
  it("persists accepted processing state, then atomically records a validated answer", () => {
    const interview = createInterview();
    const acceptedAt = new Date("2026-08-01T01:00:00.000Z");
    const plan = submitAnswerPlan(interview, "  useful answer  ", acceptedAt);

    expect(interview.version).toBe(1);
    expect(interview.questions[0]?.answerMaterial).toEqual([]);
    expect(interview.phase).toBe("awaiting_response");
    expect(plan.interview).toMatchObject({
      version: 2,
      phase: "processing",
      lastEffectiveActivityAt: acceptedAt,
      pendingOperation: {
        operationId: plan.operationId,
        operation: "answer_analysis",
        questionPosition: 1,
        acceptedAt,
        previousPhase: "awaiting_response",
      },
    });
    expect(plan.interview.questions[0]?.answerMaterial).toEqual([]);
    expect(plan.interview.questions[0]?.outcome).toBeNull();

    const completedAt = new Date("2026-08-01T02:00:00.000Z");
    const result = completeInterviewOperation(
      plan.interview,
      plan,
      evaluationCompletion(plan.interview, plan, 100, "relevant", completedAt),
    );

    expect(result.interview).toMatchObject({
      version: 2,
      phase: "awaiting_continue",
      lastEffectiveActivityAt: acceptedAt,
      pendingOperation: null,
    });
    expect(result.interview.questions[0]?.answerMaterial).toEqual([plan.material]);
    expect(result.interview.questions[0]?.outcome).toMatchObject({ kind: "scored", score: 100 });
    expect(result.events.map((event) => event.type)).toEqual([
      "answer_material_submitted",
      "question_evaluation_recorded",
    ]);
  });

  it("rejects awarded Rubric points without evidence from accepted answer material", () => {
    const interview = createInterview();
    const plan = submitAnswerPlan(interview);
    const completion = evaluationCompletion(plan.interview, plan, 100);

    expect(() =>
      completeInterviewOperation(plan.interview, plan, {
        ...completion,
        evaluation: {
          ...completion.evaluation,
          rubricItems: completion.evaluation.rubricItems.map((item) => ({
            ...item,
            evidenceMaterialIds: [],
          })),
        },
      }),
    ).toThrow(/require answer-material evidence/);
    expect(plan.interview.questions[0]?.answerMaterial).toEqual([]);
    expect(plan.interview.questions[0]?.evaluation).toBeNull();
  });

  it.each(["", "   ", "\n\t"])("rejects empty answer text %j", (text) => {
    expect(() => submitAnswerPlan(createInterview(), text)).toThrow(InvalidInterviewCommandError);
  });

  it("cancels failed model work without content or events and restores the accepted phase", () => {
    const created = createInterview();
    const answerPlan = submitAnswerPlan(created);
    const cancelledAnswer = cancelInterviewOperation(answerPlan.interview, answerPlan);

    expect(cancelledAnswer).toMatchObject({
      version: answerPlan.interview.version,
      phase: "awaiting_response",
      lastEffectiveActivityAt: answerPlan.acceptedAt,
      pendingOperation: null,
    });
    expect(cancelledAnswer.questions[0]?.answerMaterial).toEqual([]);
    expect(cancelledAnswer.questions[0]?.outcome).toBeNull();
    expect(cancelledAnswer).not.toHaveProperty("events");

    const assessed = completeEvaluation(cancelledAnswer, submitAnswerPlan(cancelledAnswer), 50);
    const supplementPlan = submitSupplementPlan(assessed);
    expect(supplementPlan.interview).toMatchObject({
      version: assessed.version + 1,
      phase: "processing",
      pendingOperation: {
        operation: "answer_analysis",
        previousPhase: "awaiting_continue",
      },
    });
    const cancelledSupplement = cancelInterviewOperation(supplementPlan.interview, supplementPlan);

    expect(cancelledSupplement).toMatchObject({
      version: supplementPlan.interview.version,
      phase: "awaiting_continue",
      pendingOperation: null,
    });
    expect(cancelledSupplement.questions[0]?.answerMaterial).toHaveLength(1);
    expect(cancelledSupplement.questions[0]?.outcome).toMatchObject({ score: 50 });
  });

  it("records user-requested clarification without consuming follow-ups or changing scoring", () => {
    const interview = createInterview();
    const requestedAt = new Date("2026-08-01T03:00:00.000Z");
    const plan = expectPlan(
      handleInterviewCommand(interview, {
        type: "request_question_clarification",
        interviewId: interview.id,
        operationId: nextOperationId(),
        expectedVersion: interview.version,
        occurredAt: requestedAt,
      }),
    );
    expect(plan.interview).toMatchObject({
      version: interview.version + 1,
      phase: "processing",
      lastEffectiveActivityAt: requestedAt,
      pendingOperation: {
        operationId: plan.operationId,
        operation: "question_clarification",
        previousPhase: "awaiting_response",
      },
    });
    expect(plan.interview.questions[0]?.questionClarifications).toEqual([]);
    const beforePrompt = getCurrentQuestion(interview);
    const completedAt = new Date("2026-08-01T04:00:00.000Z");
    const result = completeInterviewOperation(plan.interview, plan, {
      type: "record_question_clarification",
      interviewId: interview.id,
      operationId: plan.operationId,
      expectedVersion: plan.interview.version,
      occurredAt: completedAt,
      messageId: parseMessageId("clarification-message"),
      text: "This asks about the same boundary in different words.",
    });
    const question = required(result.interview.questions[0]);

    expect(result.interview.phase).toBe("awaiting_response");
    expect(result.interview.lastEffectiveActivityAt).toEqual(requestedAt);
    expect(getCurrentQuestion(result.interview)).toBe(beforePrompt);
    expect(question.systemFollowUps).toHaveLength(0);
    expect(question.evaluation).toBeNull();
    expect(question.outcome).toBeNull();
    expect(question.questionClarifications).toHaveLength(1);
  });

  it("rejects empty clarification and supplement text", () => {
    const interview = createInterview();
    const clarificationPlan = expectPlan(
      handleInterviewCommand(interview, {
        type: "request_question_clarification",
        interviewId: interview.id,
        operationId: nextOperationId(),
        expectedVersion: interview.version,
        occurredAt: STARTED_AT,
      }),
    );
    expect(() =>
      completeInterviewOperation(clarificationPlan.interview, clarificationPlan, {
        type: "record_question_clarification",
        interviewId: interview.id,
        operationId: clarificationPlan.operationId,
        expectedVersion: clarificationPlan.interview.version,
        occurredAt: STARTED_AT,
        messageId: parseMessageId("empty-clarification"),
        text: " ",
      }),
    ).toThrow(InvalidInterviewCommandError);

    const assessed = completeEvaluation(interview, submitAnswerPlan(interview), 50);
    expect(() => submitSupplementPlan(assessed, "\t")).toThrow(InvalidInterviewCommandError);
  });
});

describe("bounded system follow-ups", () => {
  it("allows at most one clarification and one depth follow-up using matching unused goals", () => {
    let interview = createInterview();
    const mainPlan = submitAnswerPlan(interview);
    interview = completeInterviewOperation(
      mainPlan.interview,
      mainPlan,
      followUpCompletion(mainPlan.interview, mainPlan, {
        kind: "clarification",
        purpose: "answer_clarification",
        classification: "ambiguous",
      }),
    ).interview;

    const clarificationAnswer = submitAnswerPlan(interview);
    expect(clarificationAnswer.operation).toBe("answer_analysis");
    if (clarificationAnswer.operation !== "answer_analysis") {
      throw new Error("Expected answer analysis");
    }
    expect(clarificationAnswer.material.kind).toBe("follow_up_answer");
    interview = completeInterviewOperation(
      clarificationAnswer.interview,
      clarificationAnswer,
      followUpCompletion(clarificationAnswer.interview, clarificationAnswer, {
        kind: "depth",
        purpose: "depth",
      }),
    ).interview;

    const depthAnswer = submitAnswerPlan(interview);
    interview = completeEvaluation(interview, depthAnswer, 100);
    const supplement = submitSupplementPlan(interview);

    expect(() =>
      completeInterviewOperation(
        supplement.interview,
        supplement,
        followUpCompletion(supplement.interview, supplement, {
          kind: "clarification",
          purpose: "answer_clarification",
          suffix: "b",
        }),
      ),
    ).toThrow(/clarification follow-up has already been used/);
    expect(() =>
      completeInterviewOperation(
        supplement.interview,
        supplement,
        followUpCompletion(supplement.interview, supplement, {
          kind: "depth",
          purpose: "depth",
          suffix: "b",
        }),
      ),
    ).toThrow(/depth follow-up has already been used/);
  });

  it("rejects unknown, reused, or kind-mismatched follow-up goals", () => {
    const interview = createInterview();
    const plan = submitAnswerPlan(interview);
    const unknown = {
      ...followUpCompletion(interview, plan, {
        kind: "clarification",
        purpose: "answer_clarification",
      }),
      goalId: parseFollowUpGoalId("not-in-snapshot"),
    };
    expect(() => completeInterviewOperation(plan.interview, plan, unknown)).toThrow(
      /predefined goal/,
    );

    const mismatch = {
      ...followUpCompletion(interview, plan, {
        kind: "clarification",
        purpose: "answer_clarification",
      }),
      goalId: parseFollowUpGoalId("depth-1-a"),
    };
    expect(() => completeInterviewOperation(plan.interview, plan, mismatch)).toThrow(
      /kind must match/,
    );
  });

  it("requires the distinct irrelevant-response clarification before an irrelevant outcome", () => {
    let interview = createInterview();
    const firstPlan = submitAnswerPlan(interview, "Completely unrelated");
    expect(() =>
      completeInterviewOperation(
        firstPlan.interview,
        firstPlan,
        evaluationCompletion(firstPlan.interview, firstPlan, 0, "irrelevant"),
      ),
    ).toThrow(/clarification opportunity first/);

    interview = completeInterviewOperation(
      firstPlan.interview,
      firstPlan,
      followUpCompletion(firstPlan.interview, firstPlan, {
        kind: "clarification",
        purpose: "irrelevant_response_clarification",
        classification: "irrelevant",
      }),
    ).interview;
    expect(interview.questions[0]?.systemFollowUps[0]?.purpose).toBe(
      "irrelevant_response_clarification",
    );

    const secondPlan = submitAnswerPlan(interview, "Still unrelated");
    interview = completeEvaluation(interview, secondPlan, 0, "irrelevant");
    expect(interview.phase).toBe("awaiting_continue");
    expect(interview.questions[0]?.outcome).toEqual({
      kind: "irrelevant",
      score: 0,
      zeroScoreReason: "irrelevant",
    });
  });

  it("allows an irrelevant outcome when the clarification allowance was already consumed", () => {
    let interview = createInterview();
    const firstPlan = submitAnswerPlan(interview, "Ambiguous answer");
    interview = completeInterviewOperation(
      firstPlan.interview,
      firstPlan,
      followUpCompletion(firstPlan.interview, firstPlan, {
        kind: "clarification",
        purpose: "answer_clarification",
        classification: "ambiguous",
      }),
    ).interview;

    const secondPlan = submitAnswerPlan(interview, "Unrelated follow-up answer");
    interview = completeEvaluation(interview, secondPlan, 0, "irrelevant");

    expect(interview.questions[0]?.outcome).toMatchObject({
      kind: "irrelevant",
      zeroScoreReason: "irrelevant",
    });
  });
});

describe("question outcomes, supplements, and continuation", () => {
  it.each([
    ["mark_question_unknown", "unknown"],
    ["skip_question", "skipped"],
  ] as const)("records %s directly without a follow-up", (type, outcomeKind) => {
    const interview = createInterview();
    const occurredAt = new Date("2026-08-01T05:00:00.000Z");
    const updated = markOutcome(interview, type, occurredAt);
    const question = required(updated.questions[0]);

    expect(updated.phase).toBe("awaiting_continue");
    expect(updated.lastEffectiveActivityAt).toEqual(occurredAt);
    expect(question.systemFollowUps).toHaveLength(0);
    expect(question.outcome?.kind).toBe(outcomeKind);
  });

  it("keeps the assessed question current until explicit continue", () => {
    const interview = markOutcome(createInterview());
    expect(interview.currentQuestionPosition).toBe(1);
    expect(getCurrentQuestion(interview).questionId).toBe(parseQuestionId("question-1"));

    const continued = continueInterview(interview);
    expect(continued.interview.currentQuestionPosition).toBe(2);
    expect(continued.interview.phase).toBe("awaiting_response");
    expect(continued.interview.questions[0]?.frozen).toBe(true);
    expect(getCurrentQuestion(continued.interview).questionId).toBe(parseQuestionId("question-2"));
  });

  it("atomically replaces a provisional outcome after a supplement and can use a remaining follow-up", () => {
    let interview = createInterview();
    interview = completeEvaluation(interview, submitAnswerPlan(interview), 50);
    const originalEvaluation = interview.questions[0]?.evaluation;
    const supplementAcceptedAt = new Date("2026-08-01T06:00:00.000Z");
    const supplement = submitSupplementPlan(interview, "Additional material", supplementAcceptedAt);

    expect(interview.questions[0]?.evaluation).toBe(originalEvaluation);
    const result = completeInterviewOperation(
      supplement.interview,
      supplement,
      followUpCompletion(supplement.interview, supplement, {
        kind: "depth",
        purpose: "depth",
      }),
    );
    interview = result.interview;

    expect(result.events.map((event) => event.type)).toEqual([
      "answer_material_submitted",
      "question_outcome_cleared",
      "system_follow_up_recorded",
    ]);
    expect(interview.phase).toBe("awaiting_response");
    expect(interview.lastEffectiveActivityAt).toEqual(supplementAcceptedAt);
    expect(interview.questions[0]?.evaluation).toBeNull();
    expect(interview.questions[0]?.outcome).toBeNull();
    expect(interview.questions[0]?.answerMaterial).toHaveLength(2);

    interview = completeEvaluation(interview, submitAnswerPlan(interview), 100);
    expect(interview.questions[0]?.outcome).toMatchObject({ kind: "scored", score: 100 });
    expect(interview.questions[0]?.answerMaterial).toHaveLength(3);
  });

  it("does not allow replacing previously submitted answer text", () => {
    const created = createInterview();
    const interview = completeEvaluation(created, submitAnswerPlan(created), 50);
    expect(() => submitAnswerPlan(interview, "Replacement")).toThrow(InvalidInterviewCommandError);
  });
});

describe("completion and terminal paths", () => {
  it("enters complete report-pending only after continuing from the final question", () => {
    let interview = createInterview();
    for (let position = 1; position <= 5; position += 1) {
      interview = markOutcome(interview);
      const result = continueInterview(interview);
      interview = result.interview;
      if (position < 5) {
        expect(interview.status).toBe("active");
        expect(interview.currentQuestionPosition).toBe(position + 1);
      }
    }

    expect(interview).toMatchObject({
      status: "report_pending",
      phase: null,
      pendingReportKind: "complete",
      reportRequestedAt: interview.lastEffectiveActivityAt,
      currentQuestionPosition: 5,
    });
    const reportResult = expectTransition(
      handleInterviewCommand(interview, {
        type: "record_report",
        interviewId: interview.id,
        operationId: nextOperationId(),
        expectedVersion: interview.version,
        occurredAt: new Date("2026-08-02T00:00:00.000Z"),
        reportId: parseReportId("complete-report"),
        reportKind: "complete",
      }),
    );
    expect(reportResult.interview).toMatchObject({
      status: "completed",
      pendingReportKind: null,
      reportRequestedAt: interview.reportRequestedAt,
      reportId: parseReportId("complete-report"),
    });
  });

  it("requires an outcome for early ending, then stores only a matching incomplete report", () => {
    let interview = createInterview();
    const earlyEnd = {
      type: "end_interview_early" as const,
      interviewId: interview.id,
      operationId: nextOperationId(),
      expectedVersion: interview.version,
      occurredAt: new Date("2026-08-01T07:00:00.000Z"),
    };
    expect(() => handleInterviewCommand(interview, earlyEnd)).toThrow(/at least one/);

    interview = markOutcome(interview, "mark_question_unknown");
    interview = expectTransition(
      handleInterviewCommand(interview, {
        ...earlyEnd,
        operationId: nextOperationId(),
        expectedVersion: interview.version,
      }),
    ).interview;
    expect(interview).toMatchObject({
      status: "report_pending",
      pendingReportKind: "incomplete",
      reportRequestedAt: earlyEnd.occurredAt,
    });

    const reportBase = {
      type: "record_report" as const,
      interviewId: interview.id,
      operationId: nextOperationId(),
      expectedVersion: interview.version,
      occurredAt: new Date("2026-08-01T08:00:00.000Z"),
      reportId: parseReportId("incomplete-report"),
    };
    expect(() =>
      handleInterviewCommand(interview, { ...reportBase, reportKind: "complete" }),
    ).toThrow(/Expected a incomplete report/);
    expect(() =>
      handleInterviewCommand(interview, {
        ...reportBase,
        operationId: nextOperationId(),
        occurredAt: new Date(earlyEnd.occurredAt.getTime() - 1),
        reportKind: "incomplete",
      }),
    ).toThrow(/cannot precede its request/);
    interview = expectTransition(
      handleInterviewCommand(interview, { ...reportBase, reportKind: "incomplete" }),
    ).interview;
    expect(interview.status).toBe("early_ended");
    expect(interview.reportRequestedAt).toEqual(earlyEnd.occurredAt);
  });

  it("abandons directly without requesting a report", () => {
    const interview = createInterview();
    const result = expectTransition(
      handleInterviewCommand(interview, {
        type: "abandon_interview",
        interviewId: interview.id,
        operationId: nextOperationId(),
        expectedVersion: interview.version,
        occurredAt: new Date("2026-08-01T09:00:00.000Z"),
      }),
    );

    expect(result.interview).toMatchObject({
      status: "abandoned",
      pendingReportKind: null,
      reportId: null,
    });
    expect(result.events).toMatchObject([{ type: "interview_abandoned", reason: "user" }]);
  });
});

describe("expiry and effective activity", () => {
  it("expires strictly after, not exactly at, 24 hours", () => {
    const interview = createInterview();
    const exactly24Hours = new Date(STARTED_AT.getTime() + 24 * 60 * 60 * 1000);
    expect(isInterviewExpired(interview, exactly24Hours)).toBe(false);
    expect(() =>
      handleInterviewCommand(interview, {
        type: "expire_interview",
        interviewId: interview.id,
        operationId: nextOperationId(),
        expectedVersion: interview.version,
        occurredAt: exactly24Hours,
      }),
    ).toThrow(/more than 24 hours/);

    const result = expectTransition(
      handleInterviewCommand(interview, {
        type: "expire_interview",
        interviewId: interview.id,
        operationId: nextOperationId(),
        expectedVersion: interview.version,
        occurredAt: new Date(exactly24Hours.getTime() + 1),
      }),
    );
    expect(result.interview.status).toBe("abandoned");
    expect(result.events).toMatchObject([{ type: "interview_abandoned", reason: "expired" }]);
  });

  it("uses accepted user-command time, not passive model completion time, as effective activity", () => {
    const interview = createInterview();
    const acceptedAt = new Date(STARTED_AT.getTime() + 23 * 60 * 60 * 1000);
    const completedAt = new Date(acceptedAt.getTime() + 60 * 60 * 1000);
    const plan = submitAnswerPlan(interview, "Late answer", acceptedAt);
    const updated = completeInterviewOperation(
      plan.interview,
      plan,
      evaluationCompletion(plan.interview, plan, 100, "relevant", completedAt),
    ).interview;

    expect(updated.lastEffectiveActivityAt).toEqual(acceptedAt);
    expect(isInterviewExpired(updated, new Date(acceptedAt.getTime() + 24 * 60 * 60 * 1000))).toBe(
      false,
    );
    expect(
      isInterviewExpired(updated, new Date(acceptedAt.getTime() + 24 * 60 * 60 * 1000 + 1)),
    ).toBe(true);
  });

  it("expires accepted processing instead of applying model output after 24 hours", () => {
    const interview = createInterview();
    const plan = submitAnswerPlan(interview);
    const completedAt = new Date(plan.acceptedAt.getTime() + 24 * 60 * 60 * 1000 + 1);
    const result = completeInterviewOperation(
      plan.interview,
      plan,
      evaluationCompletion(plan.interview, plan, 100, "relevant", completedAt),
    );

    expect(result.interview).toMatchObject({
      version: plan.interview.version,
      status: "abandoned",
      phase: null,
      pendingOperation: null,
    });
    expect(result.interview.questions[0]?.answerMaterial).toEqual([]);
    expect(result.interview.questions[0]?.evaluation).toBeNull();
    expect(result.events).toMatchObject([{ type: "interview_abandoned", reason: "expired" }]);
  });

  it("updates effective activity for explicit continue", () => {
    const interview = markOutcome(createInterview());
    const continuedAt = new Date("2026-08-01T12:00:00.000Z");
    const continued = continueInterview(interview, continuedAt).interview;
    expect(continued.lastEffectiveActivityAt).toEqual(continuedAt);
  });

  it("rejects timestamps older than the last effective activity", () => {
    const interview = markOutcome(
      createInterview(),
      "skip_question",
      new Date("2026-08-01T12:00:00.000Z"),
    );

    expect(() => continueInterview(interview, new Date("2026-08-01T11:59:59.999Z"))).toThrow(
      /cannot precede the last effective activity/,
    );
  });

  it("lazily expires an interview instead of accepting a late user command", () => {
    const interview = createInterview();
    const result = expectTransition(
      handleInterviewCommand(interview, {
        type: "skip_question",
        interviewId: interview.id,
        operationId: nextOperationId(),
        expectedVersion: interview.version,
        occurredAt: new Date(STARTED_AT.getTime() + 24 * 60 * 60 * 1000 + 1),
      }),
    );

    expect(result.interview.status).toBe("abandoned");
    expect(result.interview.questions[0]?.outcome).toBeNull();
    expect(result.events).toMatchObject([{ type: "interview_abandoned", reason: "expired" }]);
  });

  it("lazily expires before rejecting a stale expected version", () => {
    const interview = createInterview();
    const result = expectTransition(
      handleInterviewCommand(interview, {
        type: "skip_question",
        interviewId: interview.id,
        operationId: nextOperationId(),
        expectedVersion: interview.version - 1,
        occurredAt: new Date(STARTED_AT.getTime() + 24 * 60 * 60 * 1000 + 1),
      }),
    );

    expect(result.interview.status).toBe("abandoned");
    expect(result.interview.version).toBe(interview.version + 1);
  });
});

describe("concurrency and state rejection", () => {
  it("checks interview ID and version deterministically", () => {
    const interview = createInterview();
    expect(() =>
      handleInterviewCommand(interview, {
        type: "skip_question",
        interviewId: parseInterviewId("other-interview"),
        operationId: nextOperationId(),
        expectedVersion: interview.version,
        occurredAt: STARTED_AT,
      }),
    ).toThrow(InterviewIdMismatchError);
    expect(() =>
      handleInterviewCommand(interview, {
        type: "skip_question",
        interviewId: interview.id,
        operationId: nextOperationId(),
        expectedVersion: interview.version + 1,
        occurredAt: STARTED_AT,
      }),
    ).toThrow(InterviewVersionConflictError);
  });

  it("rejects stale model completions without exposing partial answer material", () => {
    const interview = createInterview();
    const plan = submitAnswerPlan(interview);
    const cancelled = cancelInterviewOperation(plan.interview, plan);
    const advanced = markOutcome(cancelled);

    expect(() =>
      completeInterviewOperation(advanced, plan, evaluationCompletion(advanced, plan, 100)),
    ).toThrow(InterviewVersionConflictError);
    expect(advanced.questions[0]?.answerMaterial).toHaveLength(0);
  });

  it("rejects concurrent commands while accepted model work is processing", () => {
    const interview = createInterview();
    const plan = submitAnswerPlan(interview);

    expect(() =>
      handleInterviewCommand(plan.interview, {
        type: "skip_question",
        interviewId: plan.interview.id,
        operationId: nextOperationId(),
        expectedVersion: plan.interview.version,
        occurredAt: new Date(plan.acceptedAt.getTime() + 1),
      }),
    ).toThrow(/processing must complete or be cancelled/);
    expect(plan.interview.questions[0]?.answerMaterial).toEqual([]);
  });

  it.each(["completed", "early_ended", "abandoned", "deleting"] as const)(
    "rejects progress mutation in terminal status %s",
    (status) => {
      const base = createInterview();
      const terminal = { ...base, status, phase: null } satisfies Interview;
      expect(() => submitAnswerPlan(terminal)).toThrow(/read-only/);
    },
  );

  it("allows report-pending to accept only the matching report completion", () => {
    let interview = createInterview();
    interview = markOutcome(interview);
    interview = expectTransition(
      handleInterviewCommand(interview, {
        type: "end_interview_early",
        interviewId: interview.id,
        operationId: nextOperationId(),
        expectedVersion: interview.version,
        occurredAt: new Date("2026-08-01T13:00:00.000Z"),
      }),
    ).interview;

    expect(() => submitAnswerPlan(interview)).toThrow(/only matching report completion/);
    expect(() =>
      handleInterviewCommand(interview, {
        type: "abandon_interview",
        interviewId: interview.id,
        operationId: nextOperationId(),
        expectedVersion: interview.version,
        occurredAt: new Date("2026-08-01T14:00:00.000Z"),
      }),
    ).toThrow(/only matching report completion/);
  });
});
