import { type Static, Type } from "typebox";

declare const wireIdentifierBrand: unique symbol;

export type WireIdentifier<Name extends string> = string & {
  readonly [wireIdentifierBrand]: Name;
};

const IDENTIFIER_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]*$";

function identifierSchema<Name extends string>(name: Name) {
  return Type.Unsafe<WireIdentifier<Name>>(
    Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: IDENTIFIER_PATTERN,
      title: name,
    }),
  );
}

export const AccountIdSchema = identifierSchema("AccountId");
export const AnswerMaterialIdSchema = identifierSchema("AnswerMaterialId");
export const EvaluationIdSchema = identifierSchema("EvaluationId");
export const FollowUpGoalIdSchema = identifierSchema("FollowUpGoalId");
export const InterviewIdSchema = identifierSchema("InterviewId");
export const MessageIdSchema = identifierSchema("MessageId");
export const OperationIdSchema = identifierSchema("OperationId");
export const QuestionIdSchema = identifierSchema("QuestionId");
export const ReportIdSchema = identifierSchema("ReportId");
export const RubricItemIdSchema = identifierSchema("RubricItemId");

export const IsoTimestampSchema = Type.String({
  format: "date-time",
});

export const InterviewStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("report_pending"),
  Type.Literal("completed"),
  Type.Literal("early_ended"),
  Type.Literal("abandoned"),
  Type.Literal("deleting"),
]);

export const InterviewPhaseSchema = Type.Union([
  Type.Literal("awaiting_response"),
  Type.Literal("processing"),
  Type.Literal("awaiting_continue"),
]);

export const ReportKindSchema = Type.Union([Type.Literal("complete"), Type.Literal("incomplete")]);

export const KNOWLEDGE_DOMAIN_VALUES = [
  "go_language",
  "concurrency_runtime_performance",
  "http_rpc_api",
  "database_storage",
  "cache_messaging_distributed",
  "testing_observability_engineering",
] as const;

export const KnowledgeDomainSchema = Type.Union(
  KNOWLEDGE_DOMAIN_VALUES.map((domain) => Type.Literal(domain)),
);

export const InterviewQuestionCountSchema = Type.Union([
  Type.Literal(5),
  Type.Literal(10),
  Type.Literal(15),
]);

export const InterviewVersionSchema = Type.Integer({ minimum: 0 });
export const PositiveVersionSchema = Type.Integer({ minimum: 1, maximum: 2_147_483_647 });
export const ScoreSchema = Type.Integer({ minimum: 0, maximum: 100 });
export const PositiveScoreSchema = Type.Integer({ minimum: 1, maximum: 100 });

export const IdempotencyKeySchema = Type.String({
  minLength: 8,
  maxLength: 255,
  pattern: "^[\\x21-\\x7E]+$",
});

export const PaginationQuerySchema = Type.Object(
  {
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  },
  { additionalProperties: false },
);

export const PageInfoSchema = Type.Object(
  {
    nextCursor: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
    hasMore: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type AccountIdDto = Static<typeof AccountIdSchema>;
export type AnswerMaterialIdDto = Static<typeof AnswerMaterialIdSchema>;
export type EvaluationIdDto = Static<typeof EvaluationIdSchema>;
export type FollowUpGoalIdDto = Static<typeof FollowUpGoalIdSchema>;
export type InterviewIdDto = Static<typeof InterviewIdSchema>;
export type MessageIdDto = Static<typeof MessageIdSchema>;
export type OperationIdDto = Static<typeof OperationIdSchema>;
export type QuestionIdDto = Static<typeof QuestionIdSchema>;
export type ReportIdDto = Static<typeof ReportIdSchema>;
export type RubricItemIdDto = Static<typeof RubricItemIdSchema>;
export type IsoTimestampDto = Static<typeof IsoTimestampSchema>;
export type InterviewStatusDto = Static<typeof InterviewStatusSchema>;
export type InterviewPhaseDto = Static<typeof InterviewPhaseSchema>;
export type ReportKindDto = Static<typeof ReportKindSchema>;
export type KnowledgeDomainDto = Static<typeof KnowledgeDomainSchema>;
export type InterviewQuestionCountDto = Static<typeof InterviewQuestionCountSchema>;
export type PaginationQueryDto = Static<typeof PaginationQuerySchema>;
export type PageInfoDto = Static<typeof PageInfoSchema>;
