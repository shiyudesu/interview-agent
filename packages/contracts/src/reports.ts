import { type Static, Type } from "typebox";
import { Check, Errors } from "typebox/value";

import {
  AnswerMaterialIdSchema,
  InterviewIdSchema,
  IsoTimestampSchema,
  KNOWLEDGE_DOMAIN_VALUES,
  KnowledgeDomainSchema,
  PositiveScoreSchema,
  PositiveVersionSchema,
  QuestionIdSchema,
  ReportIdSchema,
  RubricItemIdSchema,
  ScoreSchema,
} from "./common.js";
import { ModelCallMetadataSchema } from "./evaluation.js";

export const QuestionOutcomeKindSchema = Type.Union([
  Type.Literal("scored"),
  Type.Literal("incorrect"),
  Type.Literal("unknown"),
  Type.Literal("skipped"),
  Type.Literal("irrelevant"),
]);

export const ScoredQuestionResultSchema = Type.Object(
  {
    outcome: Type.Literal("scored"),
    score: PositiveScoreSchema,
  },
  { additionalProperties: false },
);

export const IncorrectQuestionResultSchema = Type.Object(
  {
    outcome: Type.Literal("incorrect"),
    score: Type.Literal(0),
    zeroScoreReason: Type.Literal("incorrect"),
  },
  { additionalProperties: false },
);

export const UnknownQuestionResultSchema = Type.Object(
  {
    outcome: Type.Literal("unknown"),
    score: Type.Literal(0),
    zeroScoreReason: Type.Literal("unknown"),
  },
  { additionalProperties: false },
);

export const SkippedQuestionResultSchema = Type.Object(
  {
    outcome: Type.Literal("skipped"),
    score: Type.Literal(0),
    zeroScoreReason: Type.Literal("skipped"),
  },
  { additionalProperties: false },
);

export const IrrelevantQuestionResultSchema = Type.Object(
  {
    outcome: Type.Literal("irrelevant"),
    score: Type.Literal(0),
    zeroScoreReason: Type.Literal("irrelevant"),
  },
  { additionalProperties: false },
);

export const QuestionOutcomeScoreSchema = Type.Union([
  ScoredQuestionResultSchema,
  IncorrectQuestionResultSchema,
  UnknownQuestionResultSchema,
  SkippedQuestionResultSchema,
  IrrelevantQuestionResultSchema,
]);

export const AssessedDomainResultSchema = Type.Object(
  {
    status: Type.Literal("assessed"),
    domain: KnowledgeDomainSchema,
    score: ScoreSchema,
    questionCount: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const UnassessedDomainResultSchema = Type.Object(
  {
    status: Type.Literal("unassessed"),
    domain: KnowledgeDomainSchema,
  },
  { additionalProperties: false },
);

export const DomainResultSchema = Type.Union([
  AssessedDomainResultSchema,
  UnassessedDomainResultSchema,
]);

const DomainResultsSchema = Type.Array(DomainResultSchema, {
  minItems: KNOWLEDGE_DOMAIN_VALUES.length,
  maxItems: KNOWLEDGE_DOMAIN_VALUES.length,
});

function fiveQuestionDomainResultsWithUnassessedAt(unassessedIndex: number) {
  return Type.Tuple(
    KNOWLEDGE_DOMAIN_VALUES.map((_, index) =>
      index === unassessedIndex ? UnassessedDomainResultSchema : AssessedDomainResultSchema,
    ),
  );
}

const FiveQuestionDomainResultsSchema = Type.Union([
  fiveQuestionDomainResultsWithUnassessedAt(0),
  fiveQuestionDomainResultsWithUnassessedAt(1),
  fiveQuestionDomainResultsWithUnassessedAt(2),
  fiveQuestionDomainResultsWithUnassessedAt(3),
  fiveQuestionDomainResultsWithUnassessedAt(4),
  fiveQuestionDomainResultsWithUnassessedAt(5),
]);

const AllAssessedDomainResultsSchema = Type.Array(AssessedDomainResultSchema, {
  minItems: KNOWLEDGE_DOMAIN_VALUES.length,
  maxItems: KNOWLEDGE_DOMAIN_VALUES.length,
});

export const InternalReportEvidenceReferenceSchema = Type.Union([
  Type.Object(
    {
      source: Type.Literal("answer_material"),
      answerMaterialId: AnswerMaterialIdSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      source: Type.Literal("question_snapshot"),
      questionId: QuestionIdSchema,
    },
    { additionalProperties: false },
  ),
]);

export const InternalReportKnowledgePointSchema = Type.Object(
  {
    rubricItemId: RubricItemIdSchema,
    summary: Type.String({ minLength: 1 }),
    awardedPoints: Type.Integer({ minimum: 0, maximum: 100 }),
    evidence: Type.Array(InternalReportEvidenceReferenceSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

const internalQuestionFeedbackProperties = {
  questionId: QuestionIdSchema,
  questionVersion: PositiveVersionSchema,
  // Retained only internally so exact domain counts can be validated without exposing domains publicly.
  domain: KnowledgeDomainSchema,
  position: Type.Integer({ minimum: 1 }),
  displayedQuestion: Type.String({ minLength: 1 }),
  answerSummary: Type.String({ minLength: 1 }),
  matchedKnowledgePoints: Type.Array(InternalReportKnowledgePointSchema),
  missingOrIncorrectPoints: Type.Array(InternalReportKnowledgePointSchema),
  scoreRationale: Type.String({ minLength: 1 }),
  improvementSuggestions: Type.Array(Type.String({ minLength: 1 })),
  evidence: Type.Array(InternalReportEvidenceReferenceSchema, { minItems: 1 }),
} as const;

export const InternalReportQuestionFeedbackSchema = Type.Union([
  Type.Object(
    {
      ...internalQuestionFeedbackProperties,
      outcome: Type.Literal("scored"),
      score: PositiveScoreSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...internalQuestionFeedbackProperties,
      outcome: Type.Literal("incorrect"),
      score: Type.Literal(0),
      zeroScoreReason: Type.Literal("incorrect"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...internalQuestionFeedbackProperties,
      outcome: Type.Literal("unknown"),
      score: Type.Literal(0),
      zeroScoreReason: Type.Literal("unknown"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...internalQuestionFeedbackProperties,
      outcome: Type.Literal("skipped"),
      score: Type.Literal(0),
      zeroScoreReason: Type.Literal("skipped"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...internalQuestionFeedbackProperties,
      outcome: Type.Literal("irrelevant"),
      score: Type.Literal(0),
      zeroScoreReason: Type.Literal("irrelevant"),
    },
    { additionalProperties: false },
  ),
]);

const publicQuestionFeedbackProperties = {
  position: Type.Integer({ minimum: 1 }),
  displayedQuestion: Type.String({ minLength: 1 }),
  answerSummary: Type.String({ minLength: 1 }),
  matchedKnowledgePoints: Type.Array(Type.String({ minLength: 1 })),
  missingOrIncorrectPoints: Type.Array(Type.String({ minLength: 1 })),
  scoreRationale: Type.String({ minLength: 1 }),
  improvementSuggestions: Type.Array(Type.String({ minLength: 1 })),
} as const;

export const PublicReportQuestionFeedbackSchema = Type.Union([
  Type.Object(
    {
      ...publicQuestionFeedbackProperties,
      outcome: Type.Literal("scored"),
      score: PositiveScoreSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...publicQuestionFeedbackProperties,
      outcome: Type.Literal("incorrect"),
      score: Type.Literal(0),
      zeroScoreReason: Type.Literal("incorrect"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...publicQuestionFeedbackProperties,
      outcome: Type.Literal("unknown"),
      score: Type.Literal(0),
      zeroScoreReason: Type.Literal("unknown"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...publicQuestionFeedbackProperties,
      outcome: Type.Literal("skipped"),
      score: Type.Literal(0),
      zeroScoreReason: Type.Literal("skipped"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...publicQuestionFeedbackProperties,
      outcome: Type.Literal("irrelevant"),
      score: Type.Literal(0),
      zeroScoreReason: Type.Literal("irrelevant"),
    },
    { additionalProperties: false },
  ),
]);

export const InternalReportQuestionVersionSchema = Type.Object(
  {
    questionId: QuestionIdSchema,
    questionVersion: PositiveVersionSchema,
  },
  { additionalProperties: false },
);

const reportDisplayProperties = {
  reportId: ReportIdSchema,
  interviewId: InterviewIdSchema,
  generatedAt: IsoTimestampSchema,
  overallExplanation: Type.String({ minLength: 1 }),
  strengths: Type.Array(Type.String({ minLength: 1 })),
  weaknesses: Type.Array(Type.String({ minLength: 1 })),
  priorities: Type.Array(Type.String({ minLength: 1 })),
  learningSuggestions: Type.Array(Type.String({ minLength: 1 })),
} as const;

const internalReportProperties = {
  ...reportDisplayProperties,
  schemaVersion: Type.String({ minLength: 1 }),
  modelMetadata: ModelCallMetadataSchema,
  questionVersions: Type.Array(InternalReportQuestionVersionSchema, {
    minItems: 1,
    uniqueItems: true,
  }),
} as const;

const publicReportProperties = {
  ...reportDisplayProperties,
} as const;

export const InternalCompleteReportSnapshotSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("complete"),
      ...internalReportProperties,
      domains: FiveQuestionDomainResultsSchema,
      questions: Type.Array(InternalReportQuestionFeedbackSchema, {
        minItems: 5,
        maxItems: 5,
      }),
      overallScore: ScoreSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("complete"),
      ...internalReportProperties,
      domains: AllAssessedDomainResultsSchema,
      questions: Type.Array(InternalReportQuestionFeedbackSchema, {
        minItems: 10,
        maxItems: 10,
      }),
      overallScore: ScoreSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("complete"),
      ...internalReportProperties,
      domains: AllAssessedDomainResultsSchema,
      questions: Type.Array(InternalReportQuestionFeedbackSchema, {
        minItems: 15,
        maxItems: 15,
      }),
      overallScore: ScoreSchema,
    },
    { additionalProperties: false },
  ),
]);

export const InternalIncompleteReportSnapshotSchema = Type.Object(
  {
    kind: Type.Literal("incomplete"),
    ...internalReportProperties,
    domains: DomainResultsSchema,
    questions: Type.Array(InternalReportQuestionFeedbackSchema, {
      minItems: 1,
      maxItems: 15,
    }),
  },
  { additionalProperties: false },
);

export const InternalReportSnapshotSchema = Type.Union([
  InternalCompleteReportSnapshotSchema,
  InternalIncompleteReportSnapshotSchema,
]);

export const CompleteReportResponseSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("complete"),
      ...publicReportProperties,
      domains: FiveQuestionDomainResultsSchema,
      questions: Type.Array(PublicReportQuestionFeedbackSchema, {
        minItems: 5,
        maxItems: 5,
      }),
      overallScore: ScoreSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("complete"),
      ...publicReportProperties,
      domains: AllAssessedDomainResultsSchema,
      questions: Type.Array(PublicReportQuestionFeedbackSchema, {
        minItems: 10,
        maxItems: 10,
      }),
      overallScore: ScoreSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("complete"),
      ...publicReportProperties,
      domains: AllAssessedDomainResultsSchema,
      questions: Type.Array(PublicReportQuestionFeedbackSchema, {
        minItems: 15,
        maxItems: 15,
      }),
      overallScore: ScoreSchema,
    },
    { additionalProperties: false },
  ),
]);

export const IncompleteReportResponseSchema = Type.Object(
  {
    kind: Type.Literal("incomplete"),
    ...publicReportProperties,
    domains: DomainResultsSchema,
    questions: Type.Array(PublicReportQuestionFeedbackSchema, {
      minItems: 1,
      maxItems: 15,
    }),
  },
  { additionalProperties: false },
);

export const ReportResponseSchema = Type.Union([
  CompleteReportResponseSchema,
  IncompleteReportResponseSchema,
]);

export const ReportEvidenceReferenceSchema = InternalReportEvidenceReferenceSchema;
export const ReportKnowledgePointSchema = InternalReportKnowledgePointSchema;
export const ReportQuestionFeedbackSchema = InternalReportQuestionFeedbackSchema;
export const ReportQuestionVersionSchema = InternalReportQuestionVersionSchema;
export const CompleteReportSchema = InternalCompleteReportSnapshotSchema;
export const IncompleteReportSchema = InternalIncompleteReportSnapshotSchema;
export const ReportSchema = InternalReportSnapshotSchema;

export interface ReportValidationIssue {
  readonly path: string;
  readonly code:
    | "schema"
    | "duplicate_domain"
    | "missing_domain"
    | "duplicate_position"
    | "non_contiguous_position"
    | "inconsistent_domain_question_count"
    | "duplicate_question_id"
    | "missing_question_version"
    | "extra_question_version"
    | "duplicate_question_version"
    | "mismatched_question_version";
  readonly message: string;
}

function domainCoverageIssues(value: { readonly domains: readonly { readonly domain: string }[] }) {
  const counts = new Map<string, number>();
  for (const result of value.domains) {
    counts.set(result.domain, (counts.get(result.domain) ?? 0) + 1);
  }

  const issues: ReportValidationIssue[] = [];
  for (const domain of KNOWLEDGE_DOMAIN_VALUES) {
    const count = counts.get(domain) ?? 0;
    if (count === 0) {
      issues.push({
        path: "/domains",
        code: "missing_domain",
        message: `Missing domain result for ${domain}`,
      });
    } else if (count > 1) {
      issues.push({
        path: "/domains",
        code: "duplicate_domain",
        message: `Domain ${domain} appears ${count} times`,
      });
    }
  }
  return issues;
}

function questionPositionIssues(value: {
  readonly questions: readonly { readonly position: number }[];
}) {
  const issues: ReportValidationIssue[] = [];
  const positionCounts = new Map<number, number>();
  for (const question of value.questions) {
    positionCounts.set(question.position, (positionCounts.get(question.position) ?? 0) + 1);
  }

  for (const [position, count] of positionCounts) {
    if (count > 1) {
      issues.push({
        path: "/questions",
        code: "duplicate_position",
        message: `Question feedback position ${position} appears ${count} times`,
      });
    }
  }

  const missingPositions = Array.from(
    { length: value.questions.length },
    (_, index) => index + 1,
  ).filter((position) => !positionCounts.has(position));
  if (missingPositions.length > 0) {
    issues.push({
      path: "/questions",
      code: "non_contiguous_position",
      message: `Question feedback positions must be contiguous from 1 through ${value.questions.length}; missing ${missingPositions.join(", ")}`,
    });
  }

  return issues;
}

function totalDomainQuestionCountIssues(value: {
  readonly domains: readonly {
    readonly status: "assessed" | "unassessed";
    readonly questionCount?: number;
  }[];
  readonly questions: readonly unknown[];
}) {
  const assessedQuestionCount = value.domains.reduce(
    (total, result) => (result.status === "assessed" ? total + (result.questionCount ?? 0) : total),
    0,
  );
  if (assessedQuestionCount === value.questions.length) {
    return [];
  }

  return [
    {
      path: "/domains",
      code: "inconsistent_domain_question_count" as const,
      message: `Assessed domain question counts total ${assessedQuestionCount}, but report contains ${value.questions.length} question feedback items`,
    },
  ];
}

function exactDomainQuestionCountIssues(value: {
  readonly domains: readonly {
    readonly status: "assessed" | "unassessed";
    readonly domain: string;
    readonly questionCount?: number;
  }[];
  readonly questions: readonly { readonly domain: string }[];
}) {
  const actualCounts = new Map<string, number>();
  for (const question of value.questions) {
    actualCounts.set(question.domain, (actualCounts.get(question.domain) ?? 0) + 1);
  }

  const issues: ReportValidationIssue[] = [];
  for (const result of value.domains) {
    const actualCount = actualCounts.get(result.domain) ?? 0;
    const declaredCount = result.status === "assessed" ? (result.questionCount ?? 0) : 0;
    if (declaredCount !== actualCount) {
      issues.push({
        path: "/domains",
        code: "inconsistent_domain_question_count",
        message: `Domain ${result.domain} declares ${declaredCount} questions, but internal feedback contains ${actualCount}`,
      });
    }
  }
  return issues;
}

function questionVersionIssues(value: {
  readonly questions: readonly {
    readonly questionId: string;
    readonly questionVersion: number;
  }[];
  readonly questionVersions: readonly {
    readonly questionId: string;
    readonly questionVersion: number;
  }[];
}) {
  const issues: ReportValidationIssue[] = [];
  const questionsById = new Map<string, { readonly questionVersion: number; count: number }>();
  for (const question of value.questions) {
    const existing = questionsById.get(question.questionId);
    if (existing) {
      existing.count += 1;
    } else {
      questionsById.set(question.questionId, {
        questionVersion: question.questionVersion,
        count: 1,
      });
    }
  }

  for (const [questionId, question] of questionsById) {
    if (question.count > 1) {
      issues.push({
        path: "/questions",
        code: "duplicate_question_id",
        message: `Question feedback ID ${questionId} appears ${question.count} times`,
      });
    }
  }

  const versionsById = new Map<string, number[]>();
  for (const version of value.questionVersions) {
    const versions = versionsById.get(version.questionId) ?? [];
    versions.push(version.questionVersion);
    versionsById.set(version.questionId, versions);
  }

  for (const [questionId, question] of questionsById) {
    const versions = versionsById.get(questionId) ?? [];
    if (versions.length === 0) {
      issues.push({
        path: "/questionVersions",
        code: "missing_question_version",
        message: `Missing question-version metadata for ${questionId}`,
      });
    } else if (versions.length > 1) {
      issues.push({
        path: "/questionVersions",
        code: "duplicate_question_version",
        message: `Question-version metadata for ${questionId} appears ${versions.length} times`,
      });
    } else if (versions[0] !== question.questionVersion) {
      issues.push({
        path: "/questionVersions",
        code: "mismatched_question_version",
        message: `Question-version metadata for ${questionId} is ${versions[0]}, expected ${question.questionVersion}`,
      });
    }
  }

  for (const questionId of versionsById.keys()) {
    if (!questionsById.has(questionId)) {
      issues.push({
        path: "/questionVersions",
        code: "extra_question_version",
        message: `Question-version metadata contains unknown question ${questionId}`,
      });
    }
  }

  return issues;
}

export function validateInternalReportSnapshot(value: unknown): readonly ReportValidationIssue[] {
  if (!Check(InternalReportSnapshotSchema, value)) {
    return [...Errors(InternalReportSnapshotSchema, value)].map((error) => ({
      path: error.instancePath || "/",
      code: "schema" as const,
      message: error.message,
    }));
  }
  return [
    ...domainCoverageIssues(value),
    ...questionPositionIssues(value),
    ...exactDomainQuestionCountIssues(value),
    ...questionVersionIssues(value),
  ];
}

export function validateReportResponse(value: unknown): readonly ReportValidationIssue[] {
  if (!Check(ReportResponseSchema, value)) {
    return [...Errors(ReportResponseSchema, value)].map((error) => ({
      path: error.instancePath || "/",
      code: "schema" as const,
      message: error.message,
    }));
  }
  return [
    ...domainCoverageIssues(value),
    ...questionPositionIssues(value),
    ...totalDomainQuestionCountIssues(value),
  ];
}

export type QuestionOutcomeKindDto = Static<typeof QuestionOutcomeKindSchema>;
export type QuestionOutcomeScoreDto = Static<typeof QuestionOutcomeScoreSchema>;
export type AssessedDomainResultDto = Static<typeof AssessedDomainResultSchema>;
export type UnassessedDomainResultDto = Static<typeof UnassessedDomainResultSchema>;
export type DomainResultDto = Static<typeof DomainResultSchema>;
export type InternalReportEvidenceReferenceDto = Static<
  typeof InternalReportEvidenceReferenceSchema
>;
export type InternalReportKnowledgePointDto = Static<typeof InternalReportKnowledgePointSchema>;
export type InternalReportQuestionFeedbackDto = Static<typeof InternalReportQuestionFeedbackSchema>;
export type PublicReportQuestionFeedbackDto = Static<typeof PublicReportQuestionFeedbackSchema>;
export type InternalReportQuestionVersionDto = Static<typeof InternalReportQuestionVersionSchema>;
export type InternalCompleteReportSnapshotDto = Static<typeof InternalCompleteReportSnapshotSchema>;
export type InternalIncompleteReportSnapshotDto = Static<
  typeof InternalIncompleteReportSnapshotSchema
>;
export type InternalReportSnapshotDto = Static<typeof InternalReportSnapshotSchema>;
export type CompleteReportResponseDto = Static<typeof CompleteReportResponseSchema>;
export type IncompleteReportResponseDto = Static<typeof IncompleteReportResponseSchema>;
export type ReportResponseDto = Static<typeof ReportResponseSchema>;
export type ReportEvidenceReferenceDto = InternalReportEvidenceReferenceDto;
export type ReportKnowledgePointDto = InternalReportKnowledgePointDto;
export type ReportQuestionFeedbackDto = InternalReportQuestionFeedbackDto;
export type ReportQuestionVersionDto = InternalReportQuestionVersionDto;
export type CompleteReportDto = InternalCompleteReportSnapshotDto;
export type IncompleteReportDto = InternalIncompleteReportSnapshotDto;
export type ReportDto = InternalReportSnapshotDto;
