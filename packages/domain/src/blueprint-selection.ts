import {
  deriveUnassessedDomain,
  validateInterviewBlueprintCoverage,
} from "./blueprint-coverage.js";
import {
  type InterviewBlueprint,
  type InterviewQuestionCount,
  KNOWLEDGE_DOMAINS,
  type KnowledgeDomain,
  type QuestionSnapshot,
  SUPPORTED_QUESTION_COUNTS,
} from "./interview.js";
import type { BlueprintSelectionInput, BlueprintSelector } from "./ports.js";

type DomainQuota = Readonly<Record<KnowledgeDomain, number>>;

const FNV_64_OFFSET_BASIS = 14_695_981_039_346_656_037n;
const FNV_64_PRIME = 1_099_511_628_211n;
const UINT64_MASK = (1n << 64n) - 1n;

export interface BlueprintDomainShortage {
  readonly domain: KnowledgeDomain;
  readonly required: number;
  readonly available: number;
}

export class InvalidBlueprintSelectionInputError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid blueprint selection input: ${reason}`);
    this.name = "InvalidBlueprintSelectionInputError";
  }
}

export class BlueprintSelectionShortageError extends Error {
  constructor(
    readonly shortages: readonly BlueprintDomainShortage[],
    readonly requiredTotal: number,
    readonly availableTotal: number,
  ) {
    super(
      `Insufficient eligible questions: ${[
        ...shortages.map(
          (shortage) =>
            `${shortage.domain} requires ${shortage.required}, has ${shortage.available}`,
        ),
        ...(availableTotal < requiredTotal
          ? [`total requires ${requiredTotal}, has ${availableTotal}`]
          : []),
      ].join("; ")}`,
    );
    this.name = "BlueprintSelectionShortageError";
  }
}

function blueprintDomainMinimums(
  questionCount: InterviewQuestionCount,
  selectionSeed: string,
  candidatesByDomain: ReadonlyMap<KnowledgeDomain, readonly QuestionSnapshot[]>,
  recentQuestionIds: ReadonlySet<QuestionSnapshot["questionId"]>,
): DomainQuota {
  assertQuestionCount(questionCount);
  assertSelectionSeed(selectionSeed);

  if (questionCount === 5) {
    const omittedDomain = chooseFiveQuestionOmittedDomain(
      selectionSeed,
      candidatesByDomain,
      recentQuestionIds,
    );
    return freezeQuota(
      Object.fromEntries(
        KNOWLEDGE_DOMAINS.map((domain) => [domain, domain === omittedDomain ? 0 : 1]),
      ) as Record<KnowledgeDomain, number>,
    );
  }

  const minimums = Object.fromEntries(
    KNOWLEDGE_DOMAINS.map((domain) => [domain, questionCount === 10 ? 1 : 2]),
  ) as Record<KnowledgeDomain, number>;
  if (questionCount === 10) {
    minimums.go_language = 2;
    minimums.concurrency_runtime_performance = 2;
  }
  return freezeQuota(minimums);
}

export class DeterministicBlueprintSelector implements BlueprintSelector {
  select(input: BlueprintSelectionInput): InterviewBlueprint {
    const candidatesByDomain = groupCandidates(input.eligibleQuestions);
    const minimums = blueprintDomainMinimums(
      input.questionCount,
      input.selectionSeed,
      candidatesByDomain,
      input.recentQuestionIds,
    );
    const shortages = KNOWLEDGE_DOMAINS.flatMap((domain) => {
      const required = minimums[domain];
      const available = candidatesByDomain.get(domain)?.length ?? 0;
      return available < required ? [{ domain, required, available }] : [];
    });
    if (shortages.length > 0 || input.eligibleQuestions.length < input.questionCount) {
      throw new BlueprintSelectionShortageError(
        Object.freeze(shortages),
        input.questionCount,
        input.eligibleQuestions.length,
      );
    }

    const selectedByDomain = new Map<KnowledgeDomain, QuestionSnapshot[]>();
    const selectedQuestionIds = new Set<string>();
    for (const domain of KNOWLEDGE_DOMAINS) {
      const required = minimums[domain];
      if (required === 0) {
        continue;
      }
      const candidates = candidatesByDomain.get(domain) ?? [];
      const unseen = candidates.filter(
        (candidate) => !input.recentQuestionIds.has(candidate.questionId),
      );
      const recent = candidates.filter((candidate) =>
        input.recentQuestionIds.has(candidate.questionId),
      );
      const selected = rankCandidates(input.selectionSeed, domain, unseen).slice(0, required);
      if (selected.length < required) {
        selected.push(
          ...rankCandidates(input.selectionSeed, domain, recent).slice(
            0,
            required - selected.length,
          ),
        );
      }
      for (const candidate of selected) {
        selectedQuestionIds.add(String(candidate.questionId));
      }
      selectedByDomain.set(domain, selected);
    }

    const remainingSlots =
      input.questionCount -
      [...selectedByDomain.values()].reduce((total, selected) => total + selected.length, 0);
    const remainingCandidates = input.eligibleQuestions.filter(
      (candidate) => !selectedQuestionIds.has(String(candidate.questionId)),
    );
    const unseenRemaining = remainingCandidates.filter(
      (candidate) => !input.recentQuestionIds.has(candidate.questionId),
    );
    const recentRemaining = remainingCandidates.filter((candidate) =>
      input.recentQuestionIds.has(candidate.questionId),
    );
    const flexible = rankFlexibleCandidates(input.selectionSeed, unseenRemaining).slice(
      0,
      remainingSlots,
    );
    if (flexible.length < remainingSlots) {
      flexible.push(
        ...rankFlexibleCandidates(input.selectionSeed, recentRemaining).slice(
          0,
          remainingSlots - flexible.length,
        ),
      );
    }
    if (flexible.length !== remainingSlots) {
      throw new BlueprintSelectionShortageError(
        Object.freeze([]),
        input.questionCount,
        input.eligibleQuestions.length,
      );
    }
    for (const candidate of flexible) {
      const selected = selectedByDomain.get(candidate.domain) ?? [];
      selected.push(candidate);
      selectedByDomain.set(candidate.domain, selected);
    }

    const orderedQuestions = interleaveSelectedQuestions(input.selectionSeed, selectedByDomain);
    const questions = Object.freeze(
      orderedQuestions.map((question, index) =>
        Object.freeze({
          position: index + 1,
          question: freezeSnapshot(question),
        }),
      ),
    );
    const unassessedDomain = deriveUnassessedDomain(questions, input.questionCount);
    validateInterviewBlueprintCoverage({
      questionCount: input.questionCount,
      questions,
      unassessedDomain,
    });
    return Object.freeze({
      selectionSeed: input.selectionSeed,
      unassessedDomain,
      questions,
    });
  }
}

function assertQuestionCount(
  questionCount: InterviewQuestionCount,
): asserts questionCount is InterviewQuestionCount {
  if (!(SUPPORTED_QUESTION_COUNTS as readonly number[]).includes(questionCount)) {
    throw new InvalidBlueprintSelectionInputError("question count must be 5, 10, or 15");
  }
}

function assertSelectionSeed(selectionSeed: string): void {
  if (selectionSeed.trim().length === 0) {
    throw new InvalidBlueprintSelectionInputError("selection seed must be nonblank");
  }
}

function freezeQuota(quota: Record<KnowledgeDomain, number>): DomainQuota {
  return Object.freeze(quota);
}

function chooseFiveQuestionOmittedDomain(
  selectionSeed: string,
  candidatesByDomain: ReadonlyMap<KnowledgeDomain, readonly QuestionSnapshot[]>,
  recentQuestionIds: ReadonlySet<QuestionSnapshot["questionId"]>,
): KnowledgeDomain {
  const rankedDomains = rankDomains(selectionSeed, "omitted-domain");
  const rankByDomain = new Map(rankedDomains.map((domain, index) => [domain, index]));
  const choices = KNOWLEDGE_DOMAINS.map((omittedDomain) => {
    let unavailableDomains = 0;
    let unavoidableRecentDomains = 0;
    for (const domain of KNOWLEDGE_DOMAINS) {
      if (domain === omittedDomain) {
        continue;
      }
      const candidates = candidatesByDomain.get(domain) ?? [];
      if (candidates.length === 0) {
        unavailableDomains += 1;
      } else if (candidates.every((candidate) => recentQuestionIds.has(candidate.questionId))) {
        unavoidableRecentDomains += 1;
      }
    }
    return {
      omittedDomain,
      unavailableDomains,
      unavoidableRecentDomains,
      seedRank: rankByDomain.get(omittedDomain) ?? Number.MAX_SAFE_INTEGER,
    };
  });
  choices.sort(
    (left, right) =>
      left.unavailableDomains - right.unavailableDomains ||
      left.unavoidableRecentDomains - right.unavoidableRecentDomains ||
      left.seedRank - right.seedRank,
  );
  const choice = choices[0];
  if (choice === undefined) {
    throw new InvalidBlueprintSelectionInputError("knowledge domain catalog is empty");
  }
  return choice.omittedDomain;
}

function groupCandidates(
  candidates: readonly QuestionSnapshot[],
): ReadonlyMap<KnowledgeDomain, readonly QuestionSnapshot[]> {
  const questionIds = new Set<string>();
  const grouped = new Map<KnowledgeDomain, QuestionSnapshot[]>();
  for (const candidate of candidates) {
    const questionId = String(candidate.questionId);
    if (questionIds.has(questionId)) {
      throw new InvalidBlueprintSelectionInputError(`duplicate candidate ${questionId}`);
    }
    questionIds.add(questionId);
    const domainCandidates = grouped.get(candidate.domain) ?? [];
    domainCandidates.push(candidate);
    grouped.set(candidate.domain, domainCandidates);
  }
  return grouped;
}

function freezeSnapshot(candidate: QuestionSnapshot): QuestionSnapshot {
  return Object.freeze({
    ...candidate,
    rubric: Object.freeze(candidate.rubric.map((item) => Object.freeze({ ...item }))),
    followUpGoals: Object.freeze(candidate.followUpGoals.map((goal) => Object.freeze({ ...goal }))),
  });
}

function rankCandidates(
  selectionSeed: string,
  domain: KnowledgeDomain,
  candidates: readonly QuestionSnapshot[],
): QuestionSnapshot[] {
  return [...candidates].sort(
    (left, right) =>
      compareRank(
        stableRank([
          selectionSeed,
          "candidate",
          domain,
          String(left.questionId),
          left.questionVersion,
        ]),
        stableRank([
          selectionSeed,
          "candidate",
          domain,
          String(right.questionId),
          right.questionVersion,
        ]),
      ) ||
      compareText(String(left.questionId), String(right.questionId)) ||
      left.questionVersion - right.questionVersion,
  );
}

function rankFlexibleCandidates(
  selectionSeed: string,
  candidates: readonly QuestionSnapshot[],
): QuestionSnapshot[] {
  return [...candidates].sort(
    (left, right) =>
      compareRank(
        stableRank([
          selectionSeed,
          "flexible-candidate",
          left.domain,
          String(left.questionId),
          left.questionVersion,
        ]),
        stableRank([
          selectionSeed,
          "flexible-candidate",
          right.domain,
          String(right.questionId),
          right.questionVersion,
        ]),
      ) ||
      compareText(String(left.questionId), String(right.questionId)) ||
      left.questionVersion - right.questionVersion,
  );
}

function interleaveSelectedQuestions(
  selectionSeed: string,
  selectedByDomain: ReadonlyMap<KnowledgeDomain, readonly QuestionSnapshot[]>,
): QuestionSnapshot[] {
  const queues = new Map<KnowledgeDomain, QuestionSnapshot[]>(
    Array.from(selectedByDomain, ([domain, questions]) => [domain, [...questions]] as const),
  );
  const ordered: QuestionSnapshot[] = [];
  let previousDomain: KnowledgeDomain | null = null;

  while (queues.size > 0) {
    const position = ordered.length + 1;
    const availableDomains = [...queues.keys()].sort((left, right) => {
      const remainingOrder = (queues.get(right)?.length ?? 0) - (queues.get(left)?.length ?? 0);
      return (
        remainingOrder ||
        compareRank(
          stableRank([selectionSeed, "blueprint-order", position, left]),
          stableRank([selectionSeed, "blueprint-order", position, right]),
        ) ||
        compareText(left, right)
      );
    });
    const domain =
      availableDomains.find((candidate) => candidate !== previousDomain) ?? availableDomains[0];
    if (domain === undefined) {
      throw new InvalidBlueprintSelectionInputError("selected question queues are empty");
    }
    const queue = queues.get(domain);
    if (queue === undefined) {
      throw new InvalidBlueprintSelectionInputError(`selected ${domain} queue is missing`);
    }
    const question = queue.shift();
    if (question === undefined) {
      throw new InvalidBlueprintSelectionInputError(`selected ${domain} queue is empty`);
    }
    ordered.push(question);
    previousDomain = domain;
    if (queue.length === 0) {
      queues.delete(domain);
    }
  }
  return ordered;
}

function rankDomains(selectionSeed: string, purpose: string): KnowledgeDomain[] {
  return [...KNOWLEDGE_DOMAINS].sort(
    (left, right) =>
      compareRank(
        stableRank([selectionSeed, purpose, left]),
        stableRank([selectionSeed, purpose, right]),
      ) || compareText(left, right),
  );
}

function stableRank(parts: readonly (number | string)[]): bigint {
  let hash = FNV_64_OFFSET_BASIS;
  for (const character of JSON.stringify(parts)) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = (hash * FNV_64_PRIME) & UINT64_MASK;
  }
  return hash;
}

function compareRank(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
