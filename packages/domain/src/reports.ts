import {
  type AccountId,
  type AnswerMaterialId,
  type InterviewId,
  parseAccountId,
  parseAnswerMaterialId,
  parseInterviewId,
  parseQuestionId,
  parseReportId,
  parseRubricItemId,
  type QuestionId,
  type ReportId,
  type RubricItemId,
} from "./identifiers.js";
import {
  isSupportedQuestionCount,
  KNOWLEDGE_DOMAINS,
  type KnowledgeDomain,
  parsePositiveQuestionScore,
  type QuestionOutcome,
} from "./interview.js";
import {
  aggregateCompleteInterviewScore,
  aggregateDomainScores,
  createZeroQuestionOutcome,
  type DomainScore,
  type DomainScoreResult,
} from "./scoring.js";

export interface ImmutableReportModelMetadata {
  readonly provider: string;
  readonly modelId: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly questionVersion: number | null;
  readonly purpose: string;
  readonly latencyMs: number;
  readonly tokens: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
  };
}

export type ReportEvidenceReference =
  | {
      readonly source: "answer_material";
      readonly answerMaterialId: AnswerMaterialId;
    }
  | {
      readonly source: "question_snapshot";
      readonly questionId: QuestionId;
    };

export interface ReportRubricAward {
  readonly rubricItemId: RubricItemId;
  readonly summary: string;
  readonly awardedPoints: number;
  readonly evidence: readonly ReportEvidenceReference[];
}

export interface ReportKnowledgePoint {
  readonly rubricItemId: RubricItemId;
  readonly summary: string;
  readonly evidence: readonly ReportEvidenceReference[];
}

interface ReportQuestionFeedbackBase {
  readonly questionId: QuestionId;
  readonly questionVersion: number;
  readonly domain: KnowledgeDomain;
  readonly position: number;
  readonly displayedQuestion: string;
  readonly answerSummary: string;
  readonly matchedKnowledgePoints: readonly ReportRubricAward[];
  readonly missingOrIncorrectPoints: readonly ReportKnowledgePoint[];
  readonly scoreRationale: string;
  readonly improvementSuggestions: readonly string[];
  readonly evidence: readonly ReportEvidenceReference[];
}

export type ReportQuestionFeedback =
  | (ReportQuestionFeedbackBase & {
      readonly outcome: "scored";
      readonly score: number;
    })
  | (ReportQuestionFeedbackBase & {
      readonly outcome: "incorrect" | "unknown" | "skipped" | "irrelevant";
      readonly score: 0;
      readonly zeroScoreReason: "incorrect" | "unknown" | "skipped" | "irrelevant";
    });

export interface ReportQuestionVersion {
  readonly questionId: QuestionId;
  readonly questionVersion: number;
}

interface ImmutableReportSnapshotBase {
  readonly reportId: ReportId;
  readonly interviewId: InterviewId;
  readonly accountId: AccountId;
  readonly generatedAt: string;
  readonly overallExplanation: string;
  readonly strengths: readonly string[];
  readonly weaknesses: readonly string[];
  readonly priorities: readonly string[];
  readonly learningSuggestions: readonly string[];
  readonly schemaVersion: string;
  readonly modelMetadata: ImmutableReportModelMetadata;
  readonly questionVersions: readonly ReportQuestionVersion[];
  readonly domains: readonly DomainScoreResult[];
  readonly questions: readonly ReportQuestionFeedback[];
}

export interface ImmutableCompleteReportSnapshot extends ImmutableReportSnapshotBase {
  readonly kind: "complete";
  readonly overallScore: number;
}

export interface ImmutableIncompleteReportSnapshot extends ImmutableReportSnapshotBase {
  readonly kind: "incomplete";
}

export type ImmutableReportSnapshot =
  | ImmutableCompleteReportSnapshot
  | ImmutableIncompleteReportSnapshot;

export type ReportSnapshotValidationCode =
  | "schema"
  | "duplicate_domain"
  | "missing_domain"
  | "duplicate_position"
  | "non_contiguous_position"
  | "inconsistent_domain_question_count"
  | "inconsistent_domain_score"
  | "duplicate_question_id"
  | "missing_question_version"
  | "extra_question_version"
  | "duplicate_question_version"
  | "mismatched_question_version"
  | "duplicate_rubric_award"
  | "inconsistent_question_score"
  | "inconsistent_overall_score"
  | "invalid_evidence_reference";

export interface ReportSnapshotValidationIssue {
  readonly path: string;
  readonly code: ReportSnapshotValidationCode;
  readonly message: string;
}

export class InvalidReportSnapshotError extends Error {
  constructor(readonly issues: readonly ReportSnapshotValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "InvalidReportSnapshotError";
  }
}

export function validateImmutableReportSnapshot(
  value: unknown,
): readonly ReportSnapshotValidationIssue[] {
  let snapshot: ImmutableReportSnapshot;
  try {
    snapshot = decodeSnapshot(value);
  } catch (error) {
    return [
      {
        path: "/",
        code: "schema",
        message: error instanceof Error ? error.message : "Invalid immutable report snapshot",
      },
    ];
  }
  return semanticIssues(snapshot);
}

export function parseImmutableReportSnapshot(value: unknown): ImmutableReportSnapshot {
  const snapshot = decodeSnapshot(value);
  const issues = semanticIssues(snapshot);
  if (issues.length > 0) {
    throw new InvalidReportSnapshotError(issues);
  }
  return snapshot;
}

function decodeSnapshot(value: unknown): ImmutableReportSnapshot {
  const input = record(value, "report snapshot");
  const kind = literal(input["kind"], ["complete", "incomplete"] as const, "kind");
  const commonKeys = [
    "kind",
    "reportId",
    "interviewId",
    "accountId",
    "generatedAt",
    "overallExplanation",
    "strengths",
    "weaknesses",
    "priorities",
    "learningSuggestions",
    "schemaVersion",
    "modelMetadata",
    "questionVersions",
    "domains",
    "questions",
  ];
  exactKeys(input, kind === "complete" ? [...commonKeys, "overallScore"] : commonKeys);
  const generatedAt = nonEmptyString(input["generatedAt"], "generatedAt");
  if (!isIsoDateTime(generatedAt)) {
    throw new TypeError("generatedAt must be a valid ISO date-time");
  }
  const questions = array(input["questions"], "questions").map((item, index) =>
    decodeQuestion(item, index),
  );
  if (
    (kind === "complete" && !isSupportedQuestionCount(questions.length)) ||
    (kind === "incomplete" && (questions.length < 1 || questions.length > 15))
  ) {
    throw new TypeError("questions contains an unsupported number of feedback items");
  }
  const base = {
    reportId: parseReportId(nonEmptyString(input["reportId"], "reportId")),
    interviewId: parseInterviewId(nonEmptyString(input["interviewId"], "interviewId")),
    accountId: parseAccountId(nonEmptyString(input["accountId"], "accountId")),
    generatedAt,
    overallExplanation: nonEmptyString(input["overallExplanation"], "overallExplanation"),
    strengths: nonEmptyStringArray(input["strengths"], "strengths", true),
    weaknesses: nonEmptyStringArray(input["weaknesses"], "weaknesses", true),
    priorities: nonEmptyStringArray(input["priorities"], "priorities", true),
    learningSuggestions: nonEmptyStringArray(
      input["learningSuggestions"],
      "learningSuggestions",
      true,
    ),
    schemaVersion: nonEmptyString(input["schemaVersion"], "schemaVersion"),
    modelMetadata: decodeMetadata(input["modelMetadata"]),
    questionVersions: array(input["questionVersions"], "questionVersions").map(
      decodeQuestionVersion,
    ),
    domains: array(input["domains"], "domains").map(decodeDomainResult),
    questions,
  };
  if (kind === "complete") {
    return {
      kind,
      ...base,
      overallScore: integer(input["overallScore"], "overallScore", 0, 100),
    };
  }
  return { kind, ...base };
}

function decodeQuestion(value: unknown, index: number): ReportQuestionFeedback {
  const input = record(value, `questions[${index}]`);
  const outcome = literal(
    input["outcome"],
    ["scored", "incorrect", "unknown", "skipped", "irrelevant"] as const,
    `questions[${index}].outcome`,
  );
  const commonKeys = [
    "questionId",
    "questionVersion",
    "domain",
    "position",
    "displayedQuestion",
    "answerSummary",
    "outcome",
    "score",
    "matchedKnowledgePoints",
    "missingOrIncorrectPoints",
    "scoreRationale",
    "improvementSuggestions",
    "evidence",
  ];
  exactKeys(input, outcome === "scored" ? commonKeys : [...commonKeys, "zeroScoreReason"]);
  const base = {
    questionId: parseQuestionId(
      nonEmptyString(input["questionId"], `questions[${index}].questionId`),
    ),
    questionVersion: integer(input["questionVersion"], `questions[${index}].questionVersion`, 1),
    domain: literal(input["domain"], KNOWLEDGE_DOMAINS, `questions[${index}].domain`),
    position: integer(input["position"], `questions[${index}].position`, 1),
    displayedQuestion: nonEmptyString(
      input["displayedQuestion"],
      `questions[${index}].displayedQuestion`,
    ),
    answerSummary: nonEmptyString(input["answerSummary"], `questions[${index}].answerSummary`),
    matchedKnowledgePoints: array(
      input["matchedKnowledgePoints"],
      `questions[${index}].matchedKnowledgePoints`,
    ).map((item, pointIndex) =>
      decodeRubricAward(item, `questions[${index}].matchedKnowledgePoints[${pointIndex}]`),
    ),
    missingOrIncorrectPoints: array(
      input["missingOrIncorrectPoints"],
      `questions[${index}].missingOrIncorrectPoints`,
    ).map((item, pointIndex) =>
      decodeKnowledgePoint(item, `questions[${index}].missingOrIncorrectPoints[${pointIndex}]`),
    ),
    scoreRationale: nonEmptyString(input["scoreRationale"], `questions[${index}].scoreRationale`),
    improvementSuggestions: nonEmptyStringArray(
      input["improvementSuggestions"],
      `questions[${index}].improvementSuggestions`,
      true,
    ),
    evidence: decodeEvidenceArray(input["evidence"], `questions[${index}].evidence`),
  };
  if (outcome === "scored") {
    return {
      ...base,
      outcome,
      score: integer(input["score"], `questions[${index}].score`, 1, 100),
    };
  }
  const zeroScoreReason = literal(
    input["zeroScoreReason"],
    ["incorrect", "unknown", "skipped", "irrelevant"] as const,
    `questions[${index}].zeroScoreReason`,
  );
  if (zeroScoreReason !== outcome || input["score"] !== 0) {
    throw new TypeError(`questions[${index}] zero-score fields must match outcome`);
  }
  return { ...base, outcome, score: 0, zeroScoreReason };
}

function decodeKnowledgePoint(value: unknown, path: string): ReportKnowledgePoint {
  const input = record(value, path);
  exactKeys(input, ["rubricItemId", "summary", "evidence"]);
  return {
    rubricItemId: parseRubricItemId(nonEmptyString(input["rubricItemId"], `${path}.rubricItemId`)),
    summary: nonEmptyString(input["summary"], `${path}.summary`),
    evidence: decodeEvidenceArray(input["evidence"], `${path}.evidence`),
  };
}

function decodeRubricAward(value: unknown, path: string): ReportRubricAward {
  const input = record(value, path);
  exactKeys(input, ["rubricItemId", "summary", "awardedPoints", "evidence"]);
  return {
    rubricItemId: parseRubricItemId(nonEmptyString(input["rubricItemId"], `${path}.rubricItemId`)),
    summary: nonEmptyString(input["summary"], `${path}.summary`),
    awardedPoints: integer(input["awardedPoints"], `${path}.awardedPoints`, 1, 100),
    evidence: decodeEvidenceArray(input["evidence"], `${path}.evidence`),
  };
}

function decodeEvidenceArray(value: unknown, path: string): readonly ReportEvidenceReference[] {
  const items = array(value, path);
  if (items.length === 0) {
    throw new TypeError(`${path} must contain at least one evidence reference`);
  }
  return items.map((item, index) => {
    const input = record(item, `${path}[${index}]`);
    const source = literal(
      input["source"],
      ["answer_material", "question_snapshot"] as const,
      `${path}[${index}].source`,
    );
    if (source === "answer_material") {
      exactKeys(input, ["source", "answerMaterialId"]);
      return {
        source,
        answerMaterialId: parseAnswerMaterialId(
          nonEmptyString(input["answerMaterialId"], `${path}[${index}].answerMaterialId`),
        ),
      };
    }
    exactKeys(input, ["source", "questionId"]);
    return {
      source,
      questionId: parseQuestionId(
        nonEmptyString(input["questionId"], `${path}[${index}].questionId`),
      ),
    };
  });
}

function decodeQuestionVersion(value: unknown, index: number): ReportQuestionVersion {
  const input = record(value, `questionVersions[${index}]`);
  exactKeys(input, ["questionId", "questionVersion"]);
  return {
    questionId: parseQuestionId(
      nonEmptyString(input["questionId"], `questionVersions[${index}].questionId`),
    ),
    questionVersion: integer(
      input["questionVersion"],
      `questionVersions[${index}].questionVersion`,
      1,
    ),
  };
}

function decodeDomainResult(value: unknown, index: number): DomainScoreResult {
  const input = record(value, `domains[${index}]`);
  const status = literal(
    input["status"],
    ["assessed", "unassessed"] as const,
    `domains[${index}].status`,
  );
  const domain = literal(input["domain"], KNOWLEDGE_DOMAINS, `domains[${index}].domain`);
  if (status === "unassessed") {
    exactKeys(input, ["status", "domain"]);
    return { status, domain };
  }
  exactKeys(input, ["status", "domain", "score", "questionCount"]);
  return {
    status,
    domain,
    score: integer(input["score"], `domains[${index}].score`, 0, 100) as DomainScore,
    questionCount: integer(input["questionCount"], `domains[${index}].questionCount`, 1, 15),
  };
}

function decodeMetadata(value: unknown): ImmutableReportModelMetadata {
  const input = record(value, "modelMetadata");
  exactKeys(input, [
    "provider",
    "modelId",
    "promptVersion",
    "schemaVersion",
    "questionVersion",
    "purpose",
    "latencyMs",
    "tokens",
  ]);
  const tokens = record(input["tokens"], "modelMetadata.tokens");
  exactKeys(tokens, ["inputTokens", "outputTokens"]);
  return {
    provider: nonEmptyString(input["provider"], "modelMetadata.provider"),
    modelId: nonEmptyString(input["modelId"], "modelMetadata.modelId"),
    promptVersion: nonEmptyString(input["promptVersion"], "modelMetadata.promptVersion"),
    schemaVersion: nonEmptyString(input["schemaVersion"], "modelMetadata.schemaVersion"),
    questionVersion:
      input["questionVersion"] === null
        ? null
        : integer(input["questionVersion"], "modelMetadata.questionVersion", 1),
    purpose: nonEmptyString(input["purpose"], "modelMetadata.purpose"),
    latencyMs: integer(input["latencyMs"], "modelMetadata.latencyMs", 0),
    tokens: {
      inputTokens: nullableInteger(tokens["inputTokens"], "modelMetadata.tokens.inputTokens"),
      outputTokens: nullableInteger(tokens["outputTokens"], "modelMetadata.tokens.outputTokens"),
    },
  };
}

function semanticIssues(
  snapshot: ImmutableReportSnapshot,
): readonly ReportSnapshotValidationIssue[] {
  const issues: ReportSnapshotValidationIssue[] = [];
  const domainCounts = new Map<KnowledgeDomain, number>();
  for (const result of snapshot.domains) {
    domainCounts.set(result.domain, (domainCounts.get(result.domain) ?? 0) + 1);
  }
  for (const domain of KNOWLEDGE_DOMAINS) {
    const count = domainCounts.get(domain) ?? 0;
    if (count === 0) {
      issues.push(issue("/domains", "missing_domain", `Missing domain result for ${domain}`));
    } else if (count > 1) {
      issues.push(issue("/domains", "duplicate_domain", `Domain ${domain} appears ${count} times`));
    }
  }

  const positionCounts = new Map<number, number>();
  const questionCounts = new Map<QuestionId, number>();
  const selectedQuestions: {
    readonly domain: KnowledgeDomain;
    readonly outcome: QuestionOutcome;
  }[] = [];
  snapshot.questions.forEach((question, index) => {
    positionCounts.set(question.position, (positionCounts.get(question.position) ?? 0) + 1);
    questionCounts.set(question.questionId, (questionCounts.get(question.questionId) ?? 0) + 1);
    const outcome = validateQuestionFeedback(question, index, issues);
    selectedQuestions.push({ domain: question.domain, outcome });
  });
  for (const [position, count] of positionCounts) {
    if (count > 1) {
      issues.push(
        issue(
          "/questions",
          "duplicate_position",
          `Question feedback position ${position} appears ${count} times`,
        ),
      );
    }
  }
  const missingPositions = Array.from(
    { length: snapshot.questions.length },
    (_, index) => index + 1,
  ).filter((position) => !positionCounts.has(position));
  if (missingPositions.length > 0) {
    issues.push(
      issue(
        "/questions",
        "non_contiguous_position",
        `Question feedback positions must be contiguous; missing ${missingPositions.join(", ")}`,
      ),
    );
  }
  for (const [questionId, count] of questionCounts) {
    if (count > 1) {
      issues.push(
        issue(
          "/questions",
          "duplicate_question_id",
          `Question feedback ID ${questionId} appears ${count} times`,
        ),
      );
    }
  }

  const computedDomains = aggregateDomainScores(selectedQuestions);
  compareDomains(snapshot.domains, computedDomains, issues);
  if (snapshot.kind === "complete" && isSupportedQuestionCount(selectedQuestions.length)) {
    const assessedDomainCount = computedDomains.filter(
      (result) => result.status === "assessed",
    ).length;
    const expectedAssessedDomainCount = selectedQuestions.length === 5 ? 5 : 6;
    if (assessedDomainCount !== expectedAssessedDomainCount) {
      issues.push(
        issue(
          "/domains",
          "inconsistent_domain_question_count",
          `Complete ${selectedQuestions.length}-question report requires ${expectedAssessedDomainCount} assessed domains`,
        ),
      );
    }
    const score = aggregateCompleteInterviewScore(selectedQuestions, selectedQuestions.length);
    if (snapshot.overallScore !== score.overallScore) {
      issues.push(
        issue(
          "/overallScore",
          "inconsistent_overall_score",
          "Overall score is inconsistent with question outcomes",
        ),
      );
    }
  }
  questionVersionIssues(snapshot, issues);
  return issues;
}

function validateQuestionFeedback(
  question: ReportQuestionFeedback,
  index: number,
  issues: ReportSnapshotValidationIssue[],
): QuestionOutcome {
  const awardedRubricIds = new Set<RubricItemId>();
  let score = 0;
  for (const point of question.matchedKnowledgePoints) {
    if (awardedRubricIds.has(point.rubricItemId)) {
      issues.push(
        issue(
          `/questions/${index}/matchedKnowledgePoints`,
          "duplicate_rubric_award",
          `Duplicate matched Rubric item ${point.rubricItemId}`,
        ),
      );
    }
    awardedRubricIds.add(point.rubricItemId);
    score += point.awardedPoints;
    validateEvidence(question, point.evidence, index, issues);
  }
  for (const point of question.missingOrIncorrectPoints) {
    validateEvidence(question, point.evidence, index, issues);
  }
  validateEvidence(question, question.evidence, index, issues);

  if (question.outcome === "scored") {
    if (score !== question.score) {
      issues.push(
        issue(
          `/questions/${index}/score`,
          "inconsistent_question_score",
          "Question score is inconsistent with awarded knowledge points",
        ),
      );
    }
    return { kind: "scored", score: parsePositiveQuestionScore(question.score) };
  }
  if (score !== 0) {
    issues.push(
      issue(
        `/questions/${index}/score`,
        "inconsistent_question_score",
        "Zero-score question cannot contain awarded matched knowledge points",
      ),
    );
  }
  return createZeroQuestionOutcome(question.zeroScoreReason);
}

function validateEvidence(
  question: ReportQuestionFeedback,
  references: readonly ReportEvidenceReference[],
  index: number,
  issues: ReportSnapshotValidationIssue[],
): void {
  const questionEvidence = new Set(question.evidence.map(evidenceKey));
  for (const reference of references) {
    if (
      (reference.source === "question_snapshot" && reference.questionId !== question.questionId) ||
      !questionEvidence.has(evidenceKey(reference))
    ) {
      issues.push(
        issue(
          `/questions/${index}/evidence`,
          "invalid_evidence_reference",
          "Feedback evidence must reference this question and appear in question evidence",
        ),
      );
    }
  }
}

function compareDomains(
  supplied: readonly DomainScoreResult[],
  computed: readonly DomainScoreResult[],
  issues: ReportSnapshotValidationIssue[],
): void {
  for (const expected of computed) {
    const actual = supplied.find((result) => result.domain === expected.domain);
    if (
      actual === undefined ||
      actual.status !== expected.status ||
      (actual.status === "assessed" &&
        expected.status === "assessed" &&
        actual.questionCount !== expected.questionCount)
    ) {
      issues.push(
        issue(
          "/domains",
          "inconsistent_domain_question_count",
          `Domain ${expected.domain} question count is inconsistent with feedback`,
        ),
      );
    }
    if (
      actual?.status === "assessed" &&
      expected.status === "assessed" &&
      actual.score !== expected.score
    ) {
      issues.push(
        issue(
          "/domains",
          "inconsistent_domain_score",
          `Domain ${expected.domain} score is inconsistent with feedback`,
        ),
      );
    }
  }
}

function questionVersionIssues(
  snapshot: ImmutableReportSnapshot,
  issues: ReportSnapshotValidationIssue[],
): void {
  const questionsById = new Map(
    snapshot.questions.map((question) => [question.questionId, question.questionVersion] as const),
  );
  const versionsById = new Map<QuestionId, number[]>();
  for (const version of snapshot.questionVersions) {
    const versions = versionsById.get(version.questionId) ?? [];
    versions.push(version.questionVersion);
    versionsById.set(version.questionId, versions);
  }
  for (const [questionId, questionVersion] of questionsById) {
    const versions = versionsById.get(questionId) ?? [];
    if (versions.length === 0) {
      issues.push(
        issue(
          "/questionVersions",
          "missing_question_version",
          `Missing question-version metadata for ${questionId}`,
        ),
      );
    } else if (versions.length > 1) {
      issues.push(
        issue(
          "/questionVersions",
          "duplicate_question_version",
          `Question-version metadata for ${questionId} appears ${versions.length} times`,
        ),
      );
    } else if (versions[0] !== questionVersion) {
      issues.push(
        issue(
          "/questionVersions",
          "mismatched_question_version",
          `Question-version metadata for ${questionId} is mismatched`,
        ),
      );
    }
  }
  for (const questionId of versionsById.keys()) {
    if (!questionsById.has(questionId)) {
      issues.push(
        issue(
          "/questionVersions",
          "extra_question_version",
          `Question-version metadata contains unknown question ${questionId}`,
        ),
      );
    }
  }
}

function evidenceKey(reference: ReportEvidenceReference): string {
  return reference.source === "answer_material"
    ? `answer:${reference.answerMaterialId}`
    : `question:${reference.questionId}`;
}

function issue(
  path: string,
  code: ReportSnapshotValidationCode,
  message: string,
): ReportSnapshotValidationIssue {
  return { path, code, message };
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const expectedSet = new Set(expected);
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expectedSet.has(key))) {
    throw new TypeError(`Unexpected or missing fields: ${actual.join(", ")}`);
  }
}

function array(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array`);
  }
  return value;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function nonEmptyStringArray(
  value: unknown,
  field: string,
  requireItem: boolean,
): readonly string[] {
  const values = array(value, field).map((item, index) =>
    nonEmptyString(item, `${field}[${index}]`),
  );
  if (requireItem && values.length === 0) {
    throw new TypeError(`${field} must contain at least one item`);
  }
  return values;
}

function integer(
  value: unknown,
  field: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${field} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function nullableInteger(value: unknown, field: string): number | null {
  return value === null ? null : integer(value, field, 0);
}

function literal<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  field: string,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new TypeError(`${field} is invalid`);
  }
  return value as Values[number];
}

const ISO_DATE_PATTERN = /^(\d\d\d\d)-(\d\d)-(\d\d)$/;
const ISO_TIME_PATTERN = /^(\d\d):(\d\d):(\d\d(?:\.\d+)?)(?:Z|([+-])(\d\d):(\d\d))?$/i;
const DAYS_PER_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isIsoDateTime(value: string): boolean {
  const parts = value.split(/T/i);
  return (
    parts.length === 2 && isIsoDate(requiredPart(parts[0])) && isIsoTime(requiredPart(parts[1]))
  );
}

function isIsoDate(value: string): boolean {
  const matches = ISO_DATE_PATTERN.exec(value);
  if (matches === null) {
    return false;
  }
  const year = Number(matches[1]);
  const month = Number(matches[2]);
  const day = Number(matches[3]);
  const maximumDay = month === 2 && isLeapYear(year) ? 29 : (DAYS_PER_MONTH[month] ?? 0);
  return month >= 1 && month <= 12 && day >= 1 && day <= maximumDay;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isIsoTime(value: string): boolean {
  const matches = ISO_TIME_PATTERN.exec(value);
  if (matches === null) {
    return false;
  }
  const hour = Number(matches[1]);
  const minute = Number(matches[2]);
  const second = Number(matches[3]);
  const offsetSign = matches[4] === "-" ? -1 : 1;
  const offsetHour = Number(matches[5] ?? 0);
  const offsetMinute = Number(matches[6] ?? 0);
  if (
    (matches[4] === undefined && !value.toLowerCase().includes("z")) ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return false;
  }
  if (hour <= 23 && minute <= 59 && second < 60) {
    return true;
  }
  const utcMinute = minute - offsetMinute * offsetSign;
  const utcHour = hour - offsetHour * offsetSign - (utcMinute < 0 ? 1 : 0);
  return (
    (utcHour === 23 || utcHour === -1) && (utcMinute === 59 || utcMinute === -1) && second < 61
  );
}

function requiredPart(value: string | undefined): string {
  return value ?? "";
}
