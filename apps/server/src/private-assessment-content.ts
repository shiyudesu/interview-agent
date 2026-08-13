const PRIVATE_LABEL_PATTERN =
  /(?:Rubric|评分点|评分项|评分标准|参考答案|标准答案|完整答案|答案(?:是|为)|知识说明|知识解释)/iu;
const PRIVATE_SOURCE_PATTERN =
  /(?:question[-_ ]?bank|题库(?:文件|来源)|内部题库|follow[-_ ]?up goal|追问目标)/iu;

export interface PrivateContentCandidate {
  readonly text: string;
  readonly minimumNormalizedLength: number;
}

export interface PrivateAssessmentContentScope {
  readonly privateIdentifiers: readonly string[];
  readonly leakageCandidates: readonly PrivateContentCandidate[];
}

export function mergePrivateContentScopes(
  scopes: readonly PrivateAssessmentContentScope[],
): PrivateAssessmentContentScope {
  return {
    privateIdentifiers: scopes.flatMap(({ privateIdentifiers }) => privateIdentifiers),
    leakageCandidates: scopes.flatMap(({ leakageCandidates }) => leakageCandidates),
  };
}

export function createQuestionPrivateContentScope(question: {
  readonly rubric: readonly { readonly id: unknown; readonly description: string }[];
  readonly followUpGoals: readonly { readonly id: unknown; readonly goal: string }[];
  readonly knowledgeExplanation: string;
}): PrivateAssessmentContentScope {
  return {
    privateIdentifiers: [
      ...question.rubric.map(({ id }) => String(id)),
      ...question.followUpGoals.map(({ id }) => String(id)),
    ],
    leakageCandidates: [
      ...question.rubric.map(({ description }) => ({
        text: description,
        minimumNormalizedLength: 6,
      })),
      ...question.followUpGoals.map(({ goal }) => ({
        text: goal,
        minimumNormalizedLength: 6,
      })),
      {
        text: question.knowledgeExplanation,
        minimumNormalizedLength: 12,
      },
    ],
  };
}

export function exposesPrivateContent(
  value: string,
  scope: PrivateAssessmentContentScope,
): boolean {
  if (PRIVATE_LABEL_PATTERN.test(value) || PRIVATE_SOURCE_PATTERN.test(value)) {
    return true;
  }
  const foldedValue = value.toLocaleLowerCase("en-US");
  if (
    scope.privateIdentifiers.some(
      (identifier) =>
        identifier.length >= 4 && foldedValue.includes(identifier.toLocaleLowerCase("en-US")),
    )
  ) {
    return true;
  }
  const normalizedValue = normalizeForLeakageCheck(value);
  return scope.leakageCandidates.some(({ text, minimumNormalizedLength }) => {
    const normalizedCandidate = normalizeForLeakageCheck(text);
    return (
      normalizedCandidate.length >= minimumNormalizedLength &&
      normalizedValue.includes(normalizedCandidate)
    );
  });
}

export function exposesFragmentedPrivateContent(
  values: readonly string[],
  scope: PrivateAssessmentContentScope,
): boolean {
  const normalizedValues = values.map(normalizeForLeakageCheck).filter((value) => value.length > 0);
  const candidates = [
    ...scope.leakageCandidates.flatMap(({ text, minimumNormalizedLength }) => {
      const candidate = normalizeForLeakageCheck(text);
      return candidate.length >= minimumNormalizedLength ? [candidate] : [];
    }),
    ...scope.privateIdentifiers.flatMap((identifier) => {
      const candidate = normalizeForLeakageCheck(identifier);
      return candidate.length >= 4 ? [candidate] : [];
    }),
  ];
  return candidates.some(
    (candidate) =>
      !normalizedValues.some((value) => value.includes(candidate)) &&
      isCandidateReconstructedAcrossFields(candidate, normalizedValues),
  );
}

function isCandidateReconstructedAcrossFields(
  candidate: string,
  normalizedValues: readonly string[],
): boolean {
  const candidateCharacters = [...candidate];
  let matchedPrefixes = new Int16Array(candidateCharacters.length + 1);
  matchedPrefixes.fill(-1);
  matchedPrefixes[0] = 0;

  for (const value of normalizedValues) {
    const maximumMatches = maximumCandidateMatches(candidateCharacters, [...value]);
    const nextMatches = matchedPrefixes.slice();
    for (let matchedLength = 0; matchedLength < candidateCharacters.length; matchedLength += 1) {
      const fieldCount = matchedPrefixes[matchedLength] ?? -1;
      const maximumMatch = maximumMatches[matchedLength] ?? 0;
      if (fieldCount < 0 || maximumMatch === 0) {
        continue;
      }
      for (let fragmentLength = 1; fragmentLength <= maximumMatch; fragmentLength += 1) {
        const nextLength = matchedLength + fragmentLength;
        nextMatches[nextLength] = Math.max(nextMatches[nextLength] ?? -1, fieldCount + 1);
      }
    }
    if ((nextMatches[candidateCharacters.length] ?? -1) >= 2) {
      return true;
    }
    matchedPrefixes = nextMatches;
  }
  return false;
}

function maximumCandidateMatches(
  candidate: readonly string[],
  value: readonly string[],
): Uint32Array {
  const maximumMatches = new Uint32Array(candidate.length);
  let followingRow = new Uint32Array(value.length + 1);
  for (let candidateIndex = candidate.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
    const currentRow = new Uint32Array(value.length + 1);
    let maximum = 0;
    for (let valueIndex = value.length - 1; valueIndex >= 0; valueIndex -= 1) {
      if (candidate[candidateIndex] === value[valueIndex]) {
        currentRow[valueIndex] = 1 + (followingRow[valueIndex + 1] ?? 0);
        maximum = Math.max(maximum, currentRow[valueIndex] ?? 0);
      }
    }
    maximumMatches[candidateIndex] = maximum;
    followingRow = currentRow;
  }
  return maximumMatches;
}

function normalizeForLeakageCheck(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}
