import { describe, expect, it } from "vitest";
import { parseImmutableReportSnapshot, validateImmutableReportSnapshot } from "../src/index.js";

const domains = [
  "go_language",
  "concurrency_runtime_performance",
  "http_rpc_api",
  "database_storage",
  "cache_messaging_distributed",
  "testing_observability_engineering",
] as const;

function firstFiveDomainAt(index: number): (typeof domains)[number] {
  const domain = domains[index % 5];
  if (domain === undefined) {
    throw new Error("Expected a five-domain report fixture");
  }
  return domain;
}

function reportQuestions(
  questionDomains: readonly (typeof domains)[number][] = domains.slice(0, 5),
) {
  return questionDomains.map((domain, index) => {
    const questionId = `question-${index + 1}`;
    const evidence = [{ source: "question_snapshot" as const, questionId }];
    return {
      questionId,
      questionVersion: 1,
      domain,
      position: index + 1,
      displayedQuestion: `Question ${index + 1}`,
      answerSummary: "The user marked this question unknown",
      outcome: "unknown" as const,
      score: 0 as const,
      zeroScoreReason: "unknown" as const,
      matchedKnowledgePoints: [],
      missingOrIncorrectPoints: [
        {
          rubricItemId: `rubric-${index + 1}`,
          summary: "Required knowledge point",
          evidence,
        },
      ],
      scoreRationale: "No points were awarded",
      improvementSuggestions: ["Review the required knowledge point"],
      evidence,
    };
  });
}

function domainResults(questions: readonly ReturnType<typeof reportQuestions>[number][]) {
  return domains.map((domain) => {
    const questionCount = questions.filter((question) => question.domain === domain).length;
    return questionCount === 0
      ? { status: "unassessed" as const, domain }
      : { status: "assessed" as const, domain, score: 0, questionCount };
  });
}

function completeReport(
  questionDomains: readonly (typeof domains)[number][] = domains.slice(0, 5),
) {
  const questions = reportQuestions(questionDomains);
  return {
    kind: "complete",
    reportId: "report-1",
    interviewId: "interview-1",
    accountId: "account-1",
    generatedAt: "2026-08-01T00:00:00.000Z",
    overallExplanation: "All selected questions were assessed",
    strengths: ["The interview was completed"],
    weaknesses: ["The selected topics need review"],
    priorities: ["Review the selected topics"],
    learningSuggestions: ["Use focused practice"],
    schemaVersion: "1.0",
    modelMetadata: {
      provider: "faux",
      modelId: "faux-model",
      promptVersion: "report-1",
      schemaVersion: "report-schema-1",
      questionVersion: null,
      purpose: "report_analysis",
      latencyMs: 1,
      tokens: { inputTokens: 1, outputTokens: 1 },
    },
    questionVersions: questions.map((question) => ({
      questionId: question.questionId,
      questionVersion: question.questionVersion,
    })),
    domains: domainResults(questions),
    questions,
    overallScore: 0,
  };
}

describe("immutable report snapshots", () => {
  it("accepts a complete, internally consistent snapshot", () => {
    expect(validateImmutableReportSnapshot(completeReport())).toEqual([]);
    expect(parseImmutableReportSnapshot(completeReport()).kind).toBe("complete");
  });

  it("counts a partial Rubric award once while preserving multiple missing facts", () => {
    const report = completeReport();
    const first = report.questions[0];
    if (first === undefined) {
      throw new Error("Expected first report question");
    }
    const { zeroScoreReason: _, ...firstWithoutZeroReason } = first;
    const answerEvidence = {
      source: "answer_material" as const,
      answerMaterialId: "answer-1",
    };
    const questionEvidence = {
      source: "question_snapshot" as const,
      questionId: first.questionId,
    };
    const partial = {
      ...report,
      questions: [
        {
          ...firstWithoutZeroReason,
          answerSummary: "The answer earned partial credit",
          outcome: "scored" as const,
          score: 60,
          matchedKnowledgePoints: [
            {
              rubricItemId: "rubric-1",
              summary: "Partially matched knowledge point",
              awardedPoints: 60,
              evidence: [answerEvidence],
            },
          ],
          missingOrIncorrectPoints: [
            {
              rubricItemId: "rubric-1",
              summary: "Missing edge-case detail",
              evidence: [questionEvidence],
            },
            {
              rubricItemId: "rubric-1",
              summary: "Incorrect limitation",
              evidence: [answerEvidence],
            },
          ],
          evidence: [answerEvidence, questionEvidence],
        },
        ...report.questions.slice(1),
      ],
      domains: report.domains.map((result) =>
        result.domain === "go_language" && result.status === "assessed"
          ? { ...result, score: 60 }
          : result,
      ),
      overallScore: 12,
    };

    expect(validateImmutableReportSnapshot(partial)).toEqual([]);
    expect(parseImmutableReportSnapshot(partial).questions[0]).toMatchObject({
      score: 60,
      matchedKnowledgePoints: [{ rubricItemId: "rubric-1", awardedPoints: 60 }],
      missingOrIncorrectPoints: [
        { rubricItemId: "rubric-1", summary: "Missing edge-case detail" },
        { rubricItemId: "rubric-1", summary: "Incorrect limitation" },
      ],
    });
  });

  it("rejects minimal snapshots and inconsistent score arithmetic", () => {
    expect(
      validateImmutableReportSnapshot({
        kind: "complete",
        reportId: "report-1",
        interviewId: "interview-1",
        generatedAt: "2026-08-01T00:00:00.000Z",
        overallScore: 0,
      }),
    ).toEqual([expect.objectContaining({ code: "schema" })]);
    expect(
      validateImmutableReportSnapshot({
        ...completeReport(),
        overallScore: 10,
      }),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "inconsistent_overall_score" })]),
    );
  });

  it.each([
    [5, [domains[0], domains[1], domains[2], domains[3], domains[0]]],
    [10, Array.from({ length: 10 }, (_, index) => firstFiveDomainAt(index))],
    [15, Array.from({ length: 15 }, (_, index) => firstFiveDomainAt(index))],
  ] as const)(
    "rejects a complete %i-question report without the required domain coverage",
    (_, questionDomains) => {
      expect(validateImmutableReportSnapshot(completeReport(questionDomains))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "inconsistent_domain_question_count" }),
        ]),
      );
    },
  );

  it("requires exactly six unique domain entries with per-domain question counts", () => {
    const report = completeReport();
    expect(
      validateImmutableReportSnapshot({
        ...report,
        domains: [...report.domains.slice(0, 5), { status: "unassessed", domain: domains[0] }],
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "duplicate_domain" }),
        expect.objectContaining({ code: "missing_domain" }),
      ]),
    );
    expect(
      validateImmutableReportSnapshot({
        ...report,
        domains: report.domains.map((result, index) =>
          index === 0 && result.status === "assessed" ? { ...result, questionCount: 2 } : result,
        ),
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "inconsistent_domain_question_count" }),
      ]),
    );
  });

  it("accepts internally consistent partial incomplete reports without an overall score", () => {
    const questions = reportQuestions([domains[0], domains[0], domains[2]]);
    const complete = completeReport();
    const incomplete = {
      ...complete,
      kind: "incomplete",
      questions,
      questionVersions: questions.map((question) => ({
        questionId: question.questionId,
        questionVersion: question.questionVersion,
      })),
      domains: domainResults(questions),
    };
    const { overallScore: _, ...snapshot } = incomplete;
    expect(validateImmutableReportSnapshot(snapshot)).toEqual([]);
    expect(
      validateImmutableReportSnapshot({
        ...snapshot,
        domains: snapshot.domains.map((result, index) =>
          index === 0 && result.status === "assessed" ? { ...result, questionCount: 1 } : result,
        ),
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "inconsistent_domain_question_count" }),
      ]),
    );
  });

  it.each(["1", "2026-08-01", "2026-08-01T00:00:00+24:00", "2026-08-01T00:00:00+08:60"])(
    "rejects non-canonical report timestamp %s",
    (generatedAt) => {
      expect(
        validateImmutableReportSnapshot({
          ...completeReport(),
          generatedAt,
        }),
      ).toEqual([expect.objectContaining({ code: "schema" })]);
    },
  );

  it.each(["2026-08-01T00:00:00Z", "2026-08-01T08:00:00.123+08:00"])(
    "accepts canonical report timestamp %s",
    (generatedAt) => {
      expect(validateImmutableReportSnapshot({ ...completeReport(), generatedAt })).toEqual([]);
    },
  );
});
