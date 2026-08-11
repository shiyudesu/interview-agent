import { describe, expect, it } from "vitest";

import {
  BlueprintSelectionShortageError,
  DeterministicBlueprintSelector,
  type InterviewBlueprint,
  type InterviewQuestionCount,
  InvalidBlueprintSelectionInputError,
  KNOWLEDGE_DOMAINS,
  type KnowledgeDomain,
  parseFollowUpGoalId,
  parseQuestionId,
  parseRubricItemId,
  type QuestionSnapshot,
} from "../src/index.js";

const selector = new DeterministicBlueprintSelector();

function snapshot(domain: KnowledgeDomain, index: number, version = 1): QuestionSnapshot {
  return {
    questionId: parseQuestionId(`${domain}.${index}`),
    questionVersion: version,
    domain,
    sourceWording: `${domain} source question ${index}`,
    displayedWording: `${domain} displayed question ${index}`,
    rubric: [
      {
        id: parseRubricItemId(`${domain}.${index}.rubric`),
        description: "Required point",
        weight: 100,
      },
    ],
    followUpGoals: [
      {
        id: parseFollowUpGoalId(`${domain}.${index}.clarification`),
        kind: "clarification",
        goal: "Clarify the required point",
      },
    ],
    knowledgeExplanation: `${domain} explanation ${index}`,
  };
}

function candidates(perDomain = 8): QuestionSnapshot[] {
  return KNOWLEDGE_DOMAINS.flatMap((domain) =>
    Array.from({ length: perDomain }, (_, index) => snapshot(domain, index + 1)),
  );
}

function select(
  questionCount: InterviewQuestionCount,
  selectionSeed: string,
  eligibleQuestions: readonly QuestionSnapshot[] = candidates(),
  recentQuestionIds: ReadonlySet<ReturnType<typeof parseQuestionId>> = new Set(),
): InterviewBlueprint {
  return selector.select({
    questionCount,
    selectionSeed,
    eligibleQuestions,
    recentQuestionIds,
  });
}

function domainCounts(blueprint: InterviewBlueprint): ReadonlyMap<KnowledgeDomain, number> {
  const counts = new Map<KnowledgeDomain, number>();
  for (const item of blueprint.questions) {
    counts.set(item.question.domain, (counts.get(item.question.domain) ?? 0) + 1);
  }
  return counts;
}

function identities(blueprint: InterviewBlueprint): string[] {
  return blueprint.questions.map(
    (item) => `${item.position}:${item.question.questionId}@${item.question.questionVersion}`,
  );
}

describe("deterministic blueprint selection", () => {
  it("is reproducible, independent of input order, and seed-sensitive", () => {
    const eligible = candidates(12);
    const first = select(15, "seed-alpha", eligible);
    const retry = select(15, "seed-alpha", [...eligible].reverse());
    const differentSeed = select(15, "seed-beta", eligible);

    expect(retry).toEqual(first);
    expect(identities(differentSeed)).not.toEqual(identities(first));
    expect(first.selectionSeed).toBe("seed-alpha");
  });

  it("selects five distinct domains and records the seed-determined omitted domain", () => {
    const blueprint = select(5, "five-domain-seed");
    const selectedDomains = new Set(blueprint.questions.map((item) => item.question.domain));

    expect(selectedDomains).toHaveLength(5);
    expect(blueprint.unassessedDomain).not.toBeNull();
    expect(selectedDomains.has(blueprint.unassessedDomain as KnowledgeDomain)).toBe(false);
    expect(select(5, "five-domain-seed").unassessedDomain).toBe(blueprint.unassessedDomain);
    expect(
      new Set(
        Array.from({ length: 24 }, (_, index) => select(5, `omission-${index}`).unassessedDomain),
      ).size,
    ).toBeGreaterThan(1);
  });

  it.each([10, 15] as const)("satisfies canonical %i-question coverage", (questionCount) => {
    const blueprint = select(questionCount, `coverage-${questionCount}`);
    const counts = domainCounts(blueprint);

    expect(blueprint.questions).toHaveLength(questionCount);
    expect(blueprint.unassessedDomain).toBeNull();
    for (const domain of KNOWLEDGE_DOMAINS) {
      expect(counts.get(domain) ?? 0).toBeGreaterThanOrEqual(questionCount === 10 ? 1 : 2);
    }
    if (questionCount === 10) {
      expect(counts.get("go_language") ?? 0).toBeGreaterThanOrEqual(2);
      expect(counts.get("concurrency_runtime_performance") ?? 0).toBeGreaterThanOrEqual(2);
    }
    expect([...counts.values()].reduce((total, count) => total + count, 0)).toBe(questionCount);
  });

  it("avoids recent questions independently in every required domain when unseen choices suffice", () => {
    const eligible = candidates(8);
    const recent = new Set(
      eligible
        .filter((candidate) => Number(String(candidate.questionId).split(".").at(-1)) <= 3)
        .map((candidate) => candidate.questionId),
    );
    const blueprint = select(10, "avoid-recent", eligible, recent);

    expect(blueprint.questions.every((item) => !recent.has(item.question.questionId))).toBe(true);
  });

  it("falls back to only the recent questions required by an affected domain quota", () => {
    const eligible = candidates(6);
    const goCandidates = eligible.filter((candidate) => candidate.domain === "go_language");
    const unseenGoCount = 1;
    const recent = new Set(
      goCandidates.slice(unseenGoCount).map((candidate) => candidate.questionId),
    );
    const blueprint = select(10, "recent-fallback", eligible, recent);
    const selectedGo = blueprint.questions.filter((item) => item.question.domain === "go_language");

    expect(selectedGo.length).toBeGreaterThanOrEqual(2);
    expect(selectedGo.filter((item) => recent.has(item.question.questionId))).toHaveLength(1);
    expect(
      blueprint.questions
        .filter((item) => item.question.domain !== "go_language")
        .every((item) => !recent.has(item.question.questionId)),
    ).toBe(true);
  });

  it("reports every per-domain shortage before returning a partial blueprint", () => {
    const eligible = KNOWLEDGE_DOMAINS.map((domain) => snapshot(domain, 1));
    const expectedShortages = [
      { domain: "go_language" as const, required: 2, available: 1 },
      {
        domain: "concurrency_runtime_performance" as const,
        required: 2,
        available: 1,
      },
    ];

    expect(() => select(10, "shortage", eligible)).toThrowError(
      new BlueprintSelectionShortageError(expectedShortages, 10, eligible.length),
    );
  });

  it("uses flexible unseen capacity instead of imposing seed-selected domain shortages", () => {
    const eligible = [
      ...Array.from({ length: 2 }, (_, index) => snapshot("go_language", index + 1)),
      ...Array.from({ length: 2 }, (_, index) =>
        snapshot("concurrency_runtime_performance", index + 1),
      ),
      ...Array.from({ length: 3 }, (_, index) => snapshot("http_rpc_api", index + 1)),
      snapshot("database_storage", 1),
      snapshot("cache_messaging_distributed", 1),
      snapshot("testing_observability_engineering", 1),
      snapshot("database_storage", 2),
      snapshot("cache_messaging_distributed", 2),
    ];
    const recent = new Set([
      parseQuestionId("database_storage.2"),
      parseQuestionId("cache_messaging_distributed.2"),
    ]);
    const blueprint = select(10, "review-seed", eligible, recent);

    expect(blueprint.questions).toHaveLength(10);
    expect(blueprint.questions.every((item) => !recent.has(item.question.questionId))).toBe(true);
  });

  it("omits an unavailable or recent-only domain when five better domains remain", () => {
    const unavailableEligible = KNOWLEDGE_DOMAINS.filter(
      (domain) => domain !== "database_storage",
    ).map((domain) => snapshot(domain, 1));
    const unavailableBlueprint = select(5, "feasible-omission", unavailableEligible);

    expect(unavailableBlueprint.unassessedDomain).toBe("database_storage");

    const allDomains = KNOWLEDGE_DOMAINS.map((domain) => snapshot(domain, 1));
    const recent = new Set([parseQuestionId("go_language.1")]);
    const unseenBlueprint = select(5, "recent-omission", allDomains, recent);

    expect(unseenBlueprint.unassessedDomain).toBe("go_language");
    expect(unseenBlueprint.questions.every((item) => !recent.has(item.question.questionId))).toBe(
      true,
    );
  });

  it("rejects duplicate candidates, blank seeds, and unsupported counts", () => {
    const eligible = candidates();
    expect(() => select(5, "duplicate", [...eligible, eligible[0] as QuestionSnapshot])).toThrow(
      InvalidBlueprintSelectionInputError,
    );
    expect(() => select(5, " \t")).toThrow(InvalidBlueprintSelectionInputError);
    expect(() => select(7 as InterviewQuestionCount, "unsupported")).toThrow(
      InvalidBlueprintSelectionInputError,
    );
  });

  it("returns complete frozen positions and avoids adjacent domains when alternatives exist", () => {
    const blueprint = select(15, "ordering-seed");
    const domains = blueprint.questions.map((item) => item.question.domain);

    expect(blueprint.questions.map((item) => item.position)).toEqual(
      Array.from({ length: 15 }, (_, index) => index + 1),
    );
    expect(domains.slice(1).every((domain, index) => domain !== domains[index])).toBe(true);
    expect(Object.isFrozen(blueprint)).toBe(true);
    expect(Object.isFrozen(blueprint.questions)).toBe(true);
    expect(Object.isFrozen(blueprint.questions[0]?.question.rubric)).toBe(true);
  });
});
