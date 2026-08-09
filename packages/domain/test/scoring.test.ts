import { describe, expect, it } from "vitest";

import {
  aggregateCompleteInterviewScore,
  aggregateDomainScores,
  createZeroQuestionOutcome,
  type InterviewQuestionCount,
  type InvalidRubricAwardError,
  type InvalidRubricError,
  InvalidScoreAggregationError,
  type KnowledgeDomain,
  parseAnswerMaterialId,
  parseEvaluationId,
  parseRubricItemId,
  type QuestionEvaluationInput,
  type RubricItemSnapshot,
  type SelectedQuestionScore,
  scoreQuestion,
  validateRubric,
} from "../src/index.js";

const RUBRIC: readonly RubricItemSnapshot[] = [
  {
    id: parseRubricItemId("correctness"),
    description: "Technically correct",
    weight: 50,
  },
  {
    id: parseRubricItemId("completeness"),
    description: "Covers the required details",
    weight: 30,
  },
  {
    id: parseRubricItemId("tradeoffs"),
    description: "Explains trade-offs",
    weight: 20,
  },
];

const MATERIAL_ID = parseAnswerMaterialId("answer-1");

function evaluation(
  points: readonly [number, number, number],
  classification: QuestionEvaluationInput["classification"] = "relevant",
): QuestionEvaluationInput {
  return {
    id: parseEvaluationId("evaluation-1"),
    classification,
    rubricItems: RUBRIC.map((item, index) => ({
      rubricItemId: item.id,
      evidenceMaterialIds: points[index] > 0 ? [MATERIAL_ID] : [],
      awardedPoints: points[index] ?? 0,
      missingOrIncorrectPoints: points[index] === item.weight ? [] : ["Missing detail"],
    })),
  };
}

function selected(
  domain: KnowledgeDomain,
  score: number,
  zeroReason: "incorrect" | "unknown" | "skipped" | "irrelevant" = "incorrect",
): SelectedQuestionScore {
  const evidenceMaterialId = parseAnswerMaterialId(`answer-${domain}-${score}`);
  return {
    domain,
    outcome:
      score === 0
        ? createZeroQuestionOutcome(zeroReason)
        : scoreQuestion({
            rubric: [
              {
                id: parseRubricItemId(`score-${score}`),
                description: "Score",
                weight: 100,
              },
            ],
            evaluation: {
              id: parseEvaluationId(`evaluation-${domain}-${score}`),
              classification: "relevant",
              rubricItems: [
                {
                  rubricItemId: parseRubricItemId(`score-${score}`),
                  evidenceMaterialIds: [evidenceMaterialId],
                  awardedPoints: score,
                  missingOrIncorrectPoints: [],
                },
              ],
            },
            validEvidenceMaterialIds: new Set([evidenceMaterialId]),
          }).outcome,
  };
}

const TEST_DOMAINS: readonly KnowledgeDomain[] = [
  "go_language",
  "concurrency_runtime_performance",
  "http_rpc_api",
  "database_storage",
  "cache_messaging_distributed",
  "testing_observability_engineering",
];

function completeQuestionSet(questionCount: InterviewQuestionCount): SelectedQuestionScore[] {
  return Array.from({ length: questionCount }, (_, index) =>
    selected(TEST_DOMAINS[index % TEST_DOMAINS.length] ?? "go_language", 100),
  );
}

describe("Rubric validation and deterministic question scoring", () => {
  it("sums weighted integer awards without accepting a supplied total", () => {
    const result = scoreQuestion({
      rubric: RUBRIC,
      evaluation: evaluation([40, 20, 10]),
      validEvidenceMaterialIds: new Set([MATERIAL_ID]),
    });

    expect(result.outcome).toEqual({ kind: "scored", score: 70 });
  });

  it("detaches and freezes canonical evaluation facts from mutable model input", () => {
    const mutableEvaluation = evaluation([50, 30, 20]);
    const result = scoreQuestion({
      rubric: RUBRIC,
      evaluation: mutableEvaluation,
      validEvidenceMaterialIds: new Set([MATERIAL_ID]),
    });
    const firstInputAward = mutableEvaluation.rubricItems[0];

    if (firstInputAward === undefined) {
      throw new Error("Expected Rubric award fixture");
    }
    Reflect.set(firstInputAward, "awardedPoints", 0);
    Reflect.set(firstInputAward, "evidenceMaterialIds", []);

    expect(result.rubricItems[0]).toMatchObject({
      awardedPoints: 50,
      evidenceMaterialIds: [MATERIAL_ID],
    });
    expect(result.outcome).toEqual({ kind: "scored", score: 100 });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.rubricItems)).toBe(true);
    expect(Object.isFrozen(result.rubricItems[0])).toBe(true);
  });

  it.each([
    {
      name: "empty Rubric",
      rubric: [],
      code: "rubric_empty",
    },
    {
      name: "duplicate item",
      rubric: [RUBRIC[0], RUBRIC[0]],
      code: "duplicate_rubric_item",
    },
    {
      name: "fractional weight",
      rubric: [{ ...RUBRIC[0], weight: 99.5 }],
      code: "invalid_rubric_weight",
    },
    {
      name: "weight outside range",
      rubric: [{ ...RUBRIC[0], weight: 101 }],
      code: "invalid_rubric_weight",
    },
    {
      name: "weights not totaling 100",
      rubric: [{ ...RUBRIC[0], weight: 99 }],
      code: "invalid_rubric_total",
    },
  ])("rejects $name", ({ rubric, code }) => {
    expect(() => validateRubric(rubric)).toThrowError(
      expect.objectContaining<Partial<InvalidRubricError>>({
        name: "InvalidRubricError",
        code,
      }),
    );
  });

  it.each([
    {
      name: "missing award",
      makeEvaluation: () => ({
        ...evaluation([50, 30, 20]),
        rubricItems: evaluation([50, 30, 20]).rubricItems.slice(0, -1),
      }),
      code: "award_count_mismatch",
    },
    {
      name: "unknown item",
      makeEvaluation: () => ({
        ...evaluation([50, 30, 20]),
        rubricItems: evaluation([50, 30, 20]).rubricItems.map((award, index) =>
          index === 0 ? { ...award, rubricItemId: parseRubricItemId("unknown") } : award,
        ),
      }),
      code: "invalid_rubric_item",
    },
    {
      name: "duplicate award",
      makeEvaluation: () => {
        const value = evaluation([50, 30, 20]);
        return {
          ...value,
          rubricItems: value.rubricItems.map((award, index) =>
            index === 1 ? { ...award, rubricItemId: RUBRIC[0]?.id } : award,
          ),
        };
      },
      code: "duplicate_rubric_award",
    },
    {
      name: "fractional award",
      makeEvaluation: () => ({
        ...evaluation([50, 30, 20]),
        rubricItems: evaluation([50, 30, 20]).rubricItems.map((award, index) =>
          index === 0 ? { ...award, awardedPoints: 49.5 } : award,
        ),
      }),
      code: "invalid_awarded_points",
    },
    {
      name: "negative award",
      makeEvaluation: () => ({
        ...evaluation([50, 30, 20]),
        rubricItems: evaluation([50, 30, 20]).rubricItems.map((award, index) =>
          index === 0 ? { ...award, awardedPoints: -1 } : award,
        ),
      }),
      code: "invalid_awarded_points",
    },
    {
      name: "award above weight",
      makeEvaluation: () => ({
        ...evaluation([50, 30, 20]),
        rubricItems: evaluation([50, 30, 20]).rubricItems.map((award, index) =>
          index === 0 ? { ...award, awardedPoints: 51 } : award,
        ),
      }),
      code: "invalid_awarded_points",
    },
  ])("rejects $name", ({ makeEvaluation, code }) => {
    expect(() =>
      scoreQuestion({
        rubric: RUBRIC,
        evaluation: makeEvaluation(),
        validEvidenceMaterialIds: new Set([MATERIAL_ID]),
      }),
    ).toThrowError(
      expect.objectContaining<Partial<InvalidRubricAwardError>>({
        name: "InvalidRubricAwardError",
        code,
      }),
    );
  });

  it("requires evidence for every positive Rubric award", () => {
    const value = evaluation([50, 30, 20]);
    expect(() =>
      scoreQuestion({
        rubric: RUBRIC,
        evaluation: {
          ...value,
          rubricItems: value.rubricItems.map((award, index) =>
            index === 0 ? { ...award, evidenceMaterialIds: [] } : award,
          ),
        },
        validEvidenceMaterialIds: new Set([MATERIAL_ID]),
      }),
    ).toThrowError(
      expect.objectContaining<Partial<InvalidRubricAwardError>>({
        code: "missing_evidence",
        rubricItemId: RUBRIC[0]?.id,
      }),
    );
  });

  it("validates every supplied evidence ID against the required material set", () => {
    expect(() =>
      scoreQuestion({
        rubric: RUBRIC,
        evaluation: evaluation([50, 30, 20]),
        validEvidenceMaterialIds: new Set(),
      }),
    ).toThrowError(
      expect.objectContaining<Partial<InvalidRubricAwardError>>({
        code: "invalid_evidence_reference",
        evidenceMaterialId: MATERIAL_ID,
      }),
    );
  });

  it("derives correct, partial, and incorrect outcomes from item awards", () => {
    expect(
      scoreQuestion({
        rubric: RUBRIC,
        evaluation: evaluation([50, 30, 20]),
        validEvidenceMaterialIds: new Set([MATERIAL_ID]),
      }).outcome,
    ).toEqual({
      kind: "scored",
      score: 100,
    });
    expect(
      scoreQuestion({
        rubric: RUBRIC,
        evaluation: evaluation([50, 10, 0]),
        validEvidenceMaterialIds: new Set([MATERIAL_ID]),
      }).outcome,
    ).toEqual({
      kind: "scored",
      score: 60,
    });
    expect(
      scoreQuestion({
        rubric: RUBRIC,
        evaluation: evaluation([0, 0, 0]),
        validEvidenceMaterialIds: new Set(),
      }).outcome,
    ).toEqual({
      kind: "incorrect",
      score: 0,
      zeroScoreReason: "incorrect",
    });
    expect(
      scoreQuestion({
        rubric: RUBRIC,
        evaluation: evaluation([0, 0, 0], "ambiguous"),
        validEvidenceMaterialIds: new Set(),
      }).outcome,
    ).toEqual({
      kind: "incorrect",
      score: 0,
      zeroScoreReason: "incorrect",
    });
  });

  it("preserves all four distinct zero-point reasons", () => {
    expect(createZeroQuestionOutcome("unknown")).toEqual({
      kind: "unknown",
      score: 0,
      zeroScoreReason: "unknown",
    });
    expect(createZeroQuestionOutcome("skipped")).toEqual({
      kind: "skipped",
      score: 0,
      zeroScoreReason: "skipped",
    });
    expect(
      scoreQuestion({
        rubric: RUBRIC,
        evaluation: evaluation([0, 0, 0], "irrelevant"),
        validEvidenceMaterialIds: new Set(),
      }).outcome,
    ).toEqual({
      kind: "irrelevant",
      score: 0,
      zeroScoreReason: "irrelevant",
    });
    expect(
      scoreQuestion({
        rubric: RUBRIC,
        evaluation: evaluation([0, 0, 0]),
        validEvidenceMaterialIds: new Set(),
      }).outcome,
    ).toEqual({
      kind: "incorrect",
      score: 0,
      zeroScoreReason: "incorrect",
    });
  });

  it("rejects awarded points for an irrelevant response", () => {
    expect(() =>
      scoreQuestion({
        rubric: RUBRIC,
        evaluation: evaluation([1, 0, 0], "irrelevant"),
        validEvidenceMaterialIds: new Set([MATERIAL_ID]),
      }),
    ).toThrowError(
      expect.objectContaining<Partial<InvalidRubricAwardError>>({
        code: "irrelevant_awarded_points",
      }),
    );
  });
});

describe("domain and complete-interview aggregation", () => {
  it("groups selected questions by domain and rounds halves like Math.round", () => {
    const domains = aggregateDomainScores([
      selected("go_language", 0),
      selected("go_language", 1),
      selected("database_storage", 50),
      selected("database_storage", 51),
    ]);

    expect(domains).toContainEqual({
      status: "assessed",
      domain: "go_language",
      score: 1,
      questionCount: 2,
    });
    expect(domains).toContainEqual({
      status: "assessed",
      domain: "database_storage",
      score: 51,
      questionCount: 2,
    });
  });

  it("marks the omitted domain unassessed in a five-question interview", () => {
    const questions = [
      selected("go_language", 80),
      selected("concurrency_runtime_performance", 70),
      selected("http_rpc_api", 60),
      selected("database_storage", 50),
      selected("cache_messaging_distributed", 40),
    ];
    const result = aggregateCompleteInterviewScore(questions, 5);

    expect(result.overallScore).toBe(60);
    expect(result.domains).toHaveLength(6);
    expect(result.domains).toContainEqual({
      status: "unassessed",
      domain: "testing_observability_engineering",
    });
  });

  it("includes every zero outcome in the overall average", () => {
    const result = aggregateCompleteInterviewScore(
      [
        selected("go_language", 100),
        selected("go_language", 0, "incorrect"),
        selected("http_rpc_api", 0, "unknown"),
        selected("database_storage", 0, "skipped"),
        selected("cache_messaging_distributed", 0, "irrelevant"),
      ],
      5,
    );

    expect(result.overallScore).toBe(20);
  });

  it("returns zero overall and zero for every assessed domain when completion is all-zero", () => {
    const result = aggregateCompleteInterviewScore(
      [
        selected("go_language", 0, "incorrect"),
        selected("concurrency_runtime_performance", 0, "unknown"),
        selected("http_rpc_api", 0, "skipped"),
        selected("database_storage", 0, "irrelevant"),
        selected("cache_messaging_distributed", 0, "incorrect"),
      ],
      5,
    );

    expect(result.overallScore).toBe(0);
    expect(
      result.domains
        .filter((domain) => domain.status === "assessed")
        .every((domain) => domain.score === 0),
    ).toBe(true);
    expect(result.domains.filter((domain) => domain.status === "unassessed")).toEqual([
      {
        status: "unassessed",
        domain: "testing_observability_engineering",
      },
    ]);
  });

  it.each([
    { expectedQuestionCount: 5 as const, actualQuestionCount: 1 },
    { expectedQuestionCount: 5 as const, actualQuestionCount: 4 },
    { expectedQuestionCount: 10 as const, actualQuestionCount: 5 },
    { expectedQuestionCount: 15 as const, actualQuestionCount: 10 },
  ])(
    "rejects $actualQuestionCount of $expectedQuestionCount questions as incomplete",
    ({ expectedQuestionCount, actualQuestionCount }) => {
      expect(() =>
        aggregateCompleteInterviewScore(
          completeQuestionSet(expectedQuestionCount).slice(0, actualQuestionCount),
          expectedQuestionCount,
        ),
      ).toThrowError(
        expect.objectContaining<Partial<InvalidScoreAggregationError>>({
          name: "InvalidScoreAggregationError",
          code: "question_count_mismatch",
          message: `Complete interview scoring requires exactly ${expectedQuestionCount} questions, received ${actualQuestionCount}`,
          expectedQuestionCount,
          actualQuestionCount,
        }),
      );
    },
  );

  it.each([5, 10, 15] as const)(
    "aggregates a complete supported %i-question interview",
    (questionCount) => {
      const result = aggregateCompleteInterviewScore(
        completeQuestionSet(questionCount),
        questionCount,
      );

      expect(result.overallScore).toBe(100);
      expect(
        result.domains.reduce(
          (count, domain) => count + (domain.status === "assessed" ? domain.questionCount : 0),
          0,
        ),
      ).toBe(questionCount);
    },
  );

  it("rejects complete-interview aggregation without selected questions", () => {
    expect(() => aggregateCompleteInterviewScore([], 5)).toThrow(InvalidScoreAggregationError);
  });
});
