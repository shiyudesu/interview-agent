import { describe, expect, it } from "vitest";

import {
  deriveUnassessedDomain,
  type InterviewQuestionCount,
  InvalidBlueprintCoverageError,
  KNOWLEDGE_DOMAINS,
  type KnowledgeDomain,
  validateInterviewBlueprintCoverage,
} from "../src/index.js";

function questions(domains: readonly KnowledgeDomain[]) {
  return domains.map((domain) => ({ question: { domain } }));
}

function validate(
  questionCount: InterviewQuestionCount,
  domains: readonly KnowledgeDomain[],
  unassessedDomain: KnowledgeDomain | null,
) {
  return validateInterviewBlueprintCoverage({
    questionCount,
    questions: questions(domains),
    unassessedDomain,
  });
}

describe("interview blueprint coverage", () => {
  it("accepts five distinct domains and derives the one unassessed domain", () => {
    const selected = KNOWLEDGE_DOMAINS.slice(0, 5);

    expect(deriveUnassessedDomain(questions(selected), 5)).toBe(
      "testing_observability_engineering",
    );
    expect(() => validate(5, selected, "testing_observability_engineering")).not.toThrow();
  });

  it("rejects duplicate five-question domains and mismatched unassessed metadata", () => {
    expect(() =>
      validate(
        5,
        [
          "go_language",
          "go_language",
          "http_rpc_api",
          "database_storage",
          "cache_messaging_distributed",
        ],
        "testing_observability_engineering",
      ),
    ).toThrow(InvalidBlueprintCoverageError);
    expect(() => validate(5, KNOWLEDGE_DOMAINS.slice(0, 5), "cache_messaging_distributed")).toThrow(
      InvalidBlueprintCoverageError,
    );
  });

  it("requires all domains and extra Go/concurrency representation for ten questions", () => {
    expect(() =>
      validate(
        10,
        [
          "go_language",
          "go_language",
          "concurrency_runtime_performance",
          "concurrency_runtime_performance",
          "http_rpc_api",
          "http_rpc_api",
          "database_storage",
          "database_storage",
          "cache_messaging_distributed",
          "testing_observability_engineering",
        ],
        null,
      ),
    ).not.toThrow();
    expect(() =>
      validate(
        10,
        [
          "go_language",
          "concurrency_runtime_performance",
          "concurrency_runtime_performance",
          "http_rpc_api",
          "http_rpc_api",
          "database_storage",
          "database_storage",
          "cache_messaging_distributed",
          "cache_messaging_distributed",
          "testing_observability_engineering",
        ],
        null,
      ),
    ).toThrow(InvalidBlueprintCoverageError);
  });

  it("requires at least two questions in every domain for fifteen questions", () => {
    const valid = [...KNOWLEDGE_DOMAINS, ...KNOWLEDGE_DOMAINS, ...KNOWLEDGE_DOMAINS.slice(0, 3)];
    expect(() => validate(15, valid, null)).not.toThrow();

    const invalid = valid.map((domain, index) =>
      index === 11 ? ("go_language" as const) : domain,
    );
    expect(() => validate(15, invalid, null)).toThrow(InvalidBlueprintCoverageError);
  });
});
