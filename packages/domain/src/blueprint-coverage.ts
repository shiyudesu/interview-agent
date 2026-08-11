import {
  type InterviewQuestionCount,
  KNOWLEDGE_DOMAINS,
  type KnowledgeDomain,
} from "./interview.js";

export interface BlueprintCoverageQuestion {
  readonly question: {
    readonly domain: KnowledgeDomain;
  };
}

export interface BlueprintCoverageInput {
  readonly questionCount: InterviewQuestionCount;
  readonly questions: readonly BlueprintCoverageQuestion[];
  readonly unassessedDomain: KnowledgeDomain | null;
}

export class InvalidBlueprintCoverageError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid interview blueprint coverage: ${reason}`);
    this.name = "InvalidBlueprintCoverageError";
  }
}

export function deriveUnassessedDomain(
  questions: readonly BlueprintCoverageQuestion[],
  questionCount: InterviewQuestionCount,
): KnowledgeDomain | null {
  if (questionCount !== 5) {
    return null;
  }
  const assessedDomains = new Set(questions.map((item) => item.question.domain));
  const missingDomains = KNOWLEDGE_DOMAINS.filter((domain) => !assessedDomains.has(domain));
  if (missingDomains.length !== 1) {
    throw new InvalidBlueprintCoverageError(
      `five-question interviews require exactly one unassessed domain, received ${missingDomains.length}`,
    );
  }
  return missingDomains[0] ?? null;
}

export function validateInterviewBlueprintCoverage(input: BlueprintCoverageInput): void {
  if (input.questions.length !== input.questionCount) {
    throw new InvalidBlueprintCoverageError(
      `expected ${input.questionCount} questions, received ${input.questions.length}`,
    );
  }

  const domainCounts = new Map<KnowledgeDomain, number>(
    KNOWLEDGE_DOMAINS.map((domain) => [domain, 0]),
  );
  for (const item of input.questions) {
    domainCounts.set(item.question.domain, (domainCounts.get(item.question.domain) ?? 0) + 1);
  }

  if (input.questionCount === 5) {
    const expectedUnassessedDomain = deriveUnassessedDomain(input.questions, input.questionCount);
    if (input.unassessedDomain !== expectedUnassessedDomain) {
      throw new InvalidBlueprintCoverageError(
        `declared unassessed domain ${input.unassessedDomain ?? "none"} does not match ${expectedUnassessedDomain ?? "none"}`,
      );
    }
    for (const [domain, count] of domainCounts) {
      const expected = domain === expectedUnassessedDomain ? 0 : 1;
      if (count !== expected) {
        throw new InvalidBlueprintCoverageError(
          `five-question domain ${domain} requires ${expected}, received ${count}`,
        );
      }
    }
    return;
  }

  if (input.unassessedDomain !== null) {
    throw new InvalidBlueprintCoverageError(
      `${input.questionCount}-question interviews cannot declare an unassessed domain`,
    );
  }

  for (const domain of KNOWLEDGE_DOMAINS) {
    const count = domainCounts.get(domain) ?? 0;
    const minimum =
      input.questionCount === 15
        ? 2
        : domain === "go_language" || domain === "concurrency_runtime_performance"
          ? 2
          : 1;
    if (count < minimum) {
      throw new InvalidBlueprintCoverageError(
        `${input.questionCount}-question domain ${domain} requires at least ${minimum}, received ${count}`,
      );
    }
  }
}
