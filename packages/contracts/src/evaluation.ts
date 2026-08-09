import { type Static, Type } from "typebox";

import {
  AnswerMaterialIdSchema,
  EvaluationIdSchema,
  FollowUpGoalIdSchema,
  PositiveScoreSchema,
  PositiveVersionSchema,
  RubricItemIdSchema,
} from "./common.js";

export const ResponseClassificationSchema = Type.Union([
  Type.Literal("relevant"),
  Type.Literal("ambiguous"),
  Type.Literal("irrelevant"),
]);

export const FollowUpKindSchema = Type.Union([
  Type.Literal("clarification"),
  Type.Literal("depth"),
]);

export const FollowUpPurposeSchema = Type.Union([
  Type.Literal("answer_clarification"),
  Type.Literal("irrelevant_response_clarification"),
  Type.Literal("depth"),
]);

export const ModelTokenUsageSchema = Type.Object(
  {
    inputTokens: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    outputTokens: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const ModelCallMetadataSchema = Type.Object(
  {
    provider: Type.String({ minLength: 1 }),
    modelId: Type.String({ minLength: 1 }),
    promptVersion: Type.String({ minLength: 1 }),
    schemaVersion: Type.String({ minLength: 1 }),
    questionVersion: Type.Union([PositiveVersionSchema, Type.Null()]),
    purpose: Type.String({ minLength: 1 }),
    latencyMs: Type.Integer({ minimum: 0 }),
    tokens: ModelTokenUsageSchema,
  },
  { additionalProperties: false },
);

export const RubricItemEvidenceSchema = Type.Object(
  {
    rubricItemId: RubricItemIdSchema,
    evidenceMaterialIds: Type.Array(AnswerMaterialIdSchema, { uniqueItems: true }),
    awardedPoints: Type.Integer({ minimum: 0, maximum: 100 }),
    missingOrIncorrectPoints: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
  },
  { additionalProperties: false },
);

export const PredefinedFollowUpRecommendationSchema = Type.Object(
  {
    goalId: FollowUpGoalIdSchema,
    kind: FollowUpKindSchema,
    purpose: FollowUpPurposeSchema,
  },
  { additionalProperties: false },
);

export const StructuredAnswerEvaluationSchema = Type.Object(
  {
    classification: ResponseClassificationSchema,
    rubricItems: Type.Array(RubricItemEvidenceSchema, { minItems: 1 }),
    recommendedFollowUp: Type.Union([PredefinedFollowUpRecommendationSchema, Type.Null()]),
    metadata: ModelCallMetadataSchema,
  },
  { additionalProperties: false },
);

const internalQuestionEvaluationProperties = {
  evaluationId: EvaluationIdSchema,
  rubricItems: Type.Array(RubricItemEvidenceSchema, { minItems: 1 }),
  metadata: ModelCallMetadataSchema,
} as const;

export const InternalQuestionEvaluationSchema = Type.Union([
  Type.Object(
    {
      ...internalQuestionEvaluationProperties,
      classification: Type.Union([Type.Literal("relevant"), Type.Literal("ambiguous")]),
      outcome: Type.Union([
        Type.Object(
          {
            kind: Type.Literal("scored"),
            score: PositiveScoreSchema,
          },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            kind: Type.Literal("incorrect"),
            score: Type.Literal(0),
            zeroScoreReason: Type.Literal("incorrect"),
          },
          { additionalProperties: false },
        ),
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...internalQuestionEvaluationProperties,
      classification: Type.Literal("irrelevant"),
      outcome: Type.Object(
        {
          kind: Type.Literal("irrelevant"),
          score: Type.Literal(0),
          zeroScoreReason: Type.Literal("irrelevant"),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
]);

export type ResponseClassificationDto = Static<typeof ResponseClassificationSchema>;
export type FollowUpKindDto = Static<typeof FollowUpKindSchema>;
export type FollowUpPurposeDto = Static<typeof FollowUpPurposeSchema>;
export type ModelTokenUsageDto = Static<typeof ModelTokenUsageSchema>;
export type ModelCallMetadataDto = Static<typeof ModelCallMetadataSchema>;
export type RubricItemEvidenceDto = Static<typeof RubricItemEvidenceSchema>;
export type PredefinedFollowUpRecommendationDto = Static<
  typeof PredefinedFollowUpRecommendationSchema
>;
export type StructuredAnswerEvaluationDto = Static<typeof StructuredAnswerEvaluationSchema>;
export type InternalQuestionEvaluationDto = Static<typeof InternalQuestionEvaluationSchema>;
