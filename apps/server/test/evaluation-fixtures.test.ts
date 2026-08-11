import { describe, expect, it } from "vitest";
import { validateEvaluationFixtureSuite } from "./fixtures/evaluation-fixture-validator.js";
import {
  createFixtureEvaluationRequest,
  EVALUATION_FIXTURE_CATEGORIES,
  EVALUATION_FIXTURE_SUITE,
  type EvaluationFixtureSuite,
  EXPLICIT_ZERO_OUTCOME_EVALUATION_FIXTURES,
  getModelEvaluatedEvaluationFixture,
  MODEL_EVALUATED_EVALUATION_FIXTURES,
} from "./fixtures/evaluation-fixtures.js";

interface MutableFixtureSuite {
  cases: Array<{
    caseId: string;
    category: string;
    question: {
      questionId: string;
      questionVersion: number;
      sourceWording: string;
      rubric: Array<{ weight: number }>;
      followUpGoals: Array<{ id: string }>;
    };
    answerMaterial: Array<{ text: string }>;
    modelOutput?: {
      classification: string;
      rubricItems: Array<{
        evidenceMaterialIds: string[];
        awardedPoints: number;
        missingOrIncorrectPoints: string[];
      }>;
      recommendedFollowUp: { kind: string } | null;
    };
    expected: {
      outcome: {
        score: number;
      };
    };
    untrustedInputStrings: string[];
    usedFollowUpGoalIds?: string[];
  }>;
}

function mutableFixtureSuite(): MutableFixtureSuite {
  return structuredClone(EVALUATION_FIXTURE_SUITE) as unknown as MutableFixtureSuite;
}

function requireItem<Item>(items: readonly Item[], index: number, label: string): Item {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`Missing ${label}`);
  }
  return item;
}

function validationCodesAfter(mutate: (suite: MutableFixtureSuite) => void): readonly string[] {
  const suite = mutableFixtureSuite();
  mutate(suite);
  return validateEvaluationFixtureSuite(suite as unknown as EvaluationFixtureSuite).map(
    ({ code }) => code,
  );
}

describe("evaluation fixture suite", () => {
  it("validates every versioned category and deterministic expected semantic", () => {
    expect(validateEvaluationFixtureSuite(EVALUATION_FIXTURE_SUITE)).toEqual([]);
    expect(EVALUATION_FIXTURE_SUITE.cases.map(({ category }) => category)).toEqual(
      EVALUATION_FIXTURE_CATEGORIES,
    );
  });

  it("keeps explicit unknown and skipped outcomes separate from model-evaluated answers", () => {
    expect(MODEL_EVALUATED_EVALUATION_FIXTURES).toHaveLength(6);
    expect(
      MODEL_EVALUATED_EVALUATION_FIXTURES.every(
        ({ answerMaterial, execution }) =>
          execution === "model_evaluated" && answerMaterial.length > 0,
      ),
    ).toBe(true);
    expect(
      EXPLICIT_ZERO_OUTCOME_EVALUATION_FIXTURES.map(
        ({ category, command, expected, execution }) => ({
          category,
          command,
          execution,
          classification: expected.classification,
          outcome: expected.outcome,
        }),
      ),
    ).toEqual([
      {
        category: "explicit_unknown",
        command: "mark_unknown",
        execution: "explicit_zero_outcome",
        classification: null,
        outcome: { kind: "unknown", score: 0, zeroScoreReason: "unknown" },
      },
      {
        category: "explicit_skipped",
        command: "skip",
        execution: "explicit_zero_outcome",
        classification: null,
        outcome: { kind: "skipped", score: 0, zeroScoreReason: "skipped" },
      },
    ]);
  });

  it("reports ID, category, Rubric, evidence, semantic, language, and trust-boundary drift", () => {
    expect(
      validationCodesAfter((suite) => {
        const firstCase = requireItem(suite.cases, 0, "first fixture case");
        requireItem(suite.cases, 1, "second fixture case").caseId = firstCase.caseId;
      }),
    ).toContain("duplicate_case_id");
    expect(
      validationCodesAfter((suite) => {
        requireItem(suite.cases, 2, "third fixture case").category = "unsupported";
      }),
    ).toContain("unsupported_category");
    expect(
      validationCodesAfter((suite) => {
        const firstCase = requireItem(suite.cases, 0, "first fixture case");
        requireItem(firstCase.question.rubric, 0, "first fixture Rubric item").weight = 59;
      }),
    ).toContain("invalid_rubric");
    expect(
      validationCodesAfter((suite) => {
        const firstCase = requireItem(suite.cases, 0, "first fixture case");
        const modelOutput = firstCase.modelOutput;
        if (modelOutput === undefined) {
          throw new Error("Expected first fixture case to use model evaluation");
        }
        requireItem(modelOutput.rubricItems, 0, "first fixture output item").evidenceMaterialIds = [
          "not-supplied",
        ];
      }),
    ).toContain("invalid_evidence_reference");
    expect(
      validationCodesAfter((suite) => {
        requireItem(suite.cases, 0, "first fixture case").expected.outcome.score = 99;
      }),
    ).toContain("expected_outcome_mismatch");
    expect(
      validationCodesAfter((suite) => {
        requireItem(suite.cases, 0, "first fixture case").question.sourceWording =
          "請說明取消訊號如何傳播。";
      }),
    ).toContain("non_simplified_chinese");
    expect(
      validationCodesAfter((suite) => {
        const injectionCase = requireItem(suite.cases, 7, "prompt-injection fixture case");
        requireItem(injectionCase.answerMaterial, 0, "prompt-injection answer").text =
          "父 Context 取消时会通知派生 Context。";
      }),
    ).toContain("injection_not_untrusted");
    expect(
      validationCodesAfter((suite) => {
        requireItem(suite.cases, 0, "first fixture case").question.questionVersion = 0;
      }),
    ).toContain("invalid_question_identity");
    expect(
      validationCodesAfter((suite) => {
        requireItem(suite.cases, 0, "first fixture case").question.questionId = "bad id";
      }),
    ).toContain("invalid_question_identity");
    expect(
      validationCodesAfter((suite) => {
        const firstCase = requireItem(suite.cases, 0, "first fixture case");
        firstCase.usedFollowUpGoalIds = ["bad id"];
      }),
    ).toContain("invalid_used_follow_up_goal");
    expect(
      validationCodesAfter((suite) => {
        const firstCase = requireItem(suite.cases, 0, "correct fixture");
        const output = firstCase.modelOutput;
        if (output === undefined) {
          throw new Error("Expected model output");
        }
        requireItem(output.rubricItems, 0, "full award").missingOrIncorrectPoints = [
          "不应存在的缺失项",
        ];
      }),
    ).toContain("unexpected_missing_points");
    expect(
      validationCodesAfter((suite) => {
        const partialCase = requireItem(suite.cases, 1, "partial fixture");
        const output = partialCase.modelOutput;
        if (output === undefined) {
          throw new Error("Expected model output");
        }
        requireItem(output.rubricItems, 1, "under-awarded item").missingOrIncorrectPoints = [];
      }),
    ).toContain("missing_points_required");
    expect(
      validationCodesAfter((suite) => {
        const irrelevantCase = requireItem(suite.cases, 5, "irrelevant fixture");
        irrelevantCase.usedFollowUpGoalIds = [];
      }),
    ).toContain("irrelevant_clarification_required");
    expect(
      validationCodesAfter((suite) => {
        const ambiguousCase = requireItem(suite.cases, 6, "ambiguous fixture");
        ambiguousCase.usedFollowUpGoalIds = ["goal-used"];
      }),
    ).toContain("follow_up_kind_already_used");
  });

  it("creates fresh mutable Date values without mutating versioned fixtures", () => {
    const fixture = getModelEvaluatedEvaluationFixture("evaluation.context.correct");
    const first = createFixtureEvaluationRequest(fixture);
    const second = createFixtureEvaluationRequest(fixture);
    const firstDate = requireItem(first.answerMaterial, 0, "first request material").submittedAt;
    const secondDate = requireItem(second.answerMaterial, 0, "second request material").submittedAt;

    expect(firstDate).not.toBe(secondDate);
    firstDate.setTime(0);
    expect(secondDate.toISOString()).toBe("2026-08-11T10:00:00.000Z");
    expect(fixture.answerMaterial[0]?.submittedAt).toBe("2026-08-11T10:00:00.000Z");
  });
});
