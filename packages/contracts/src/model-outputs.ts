import { type Static, Type } from "typebox";

import { AnswerMaterialIdSchema, QuestionIdSchema } from "./common.js";
import {
  ModelCallMetadataSchema,
  PredefinedFollowUpRecommendationSchema,
  ResponseClassificationSchema,
  RubricItemEvidenceSchema,
} from "./evaluation.js";

export const InterviewerTextOutputSchema = Type.String({
  minLength: 1,
  maxLength: 2_000,
});

export const ModelAnswerEvaluationOutputSchema = Type.Object(
  {
    classification: ResponseClassificationSchema,
    rubricItems: Type.Array(RubricItemEvidenceSchema, { minItems: 1 }),
    recommendedFollowUp: Type.Union([PredefinedFollowUpRecommendationSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export const StructuredReportQuestionAnalysisSchema = Type.Object(
  {
    questionId: QuestionIdSchema,
    answerSummary: Type.String({ minLength: 1 }),
    scoreRationale: Type.String({ minLength: 1 }),
    improvementSuggestions: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    evidenceMaterialIds: Type.Array(AnswerMaterialIdSchema, { uniqueItems: true }),
  },
  { additionalProperties: false },
);

const reportAnalysisProperties = {
  overallExplanation: Type.String({ minLength: 1 }),
  strengths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  weaknesses: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  priorities: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  learningSuggestions: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  perQuestion: Type.Array(StructuredReportQuestionAnalysisSchema, { minItems: 1 }),
} as const;

export const ModelReportAnalysisOutputSchema = Type.Object(reportAnalysisProperties, {
  additionalProperties: false,
});

export const StructuredReportAnalysisSchema = Type.Object(
  {
    ...reportAnalysisProperties,
    metadata: ModelCallMetadataSchema,
  },
  { additionalProperties: false },
);

export type InterviewerTextOutputDto = Static<typeof InterviewerTextOutputSchema>;
export type ModelAnswerEvaluationOutputDto = Static<typeof ModelAnswerEvaluationOutputSchema>;
export type ModelReportAnalysisOutputDto = Static<typeof ModelReportAnalysisOutputSchema>;
export type StructuredReportQuestionAnalysisDto = Static<
  typeof StructuredReportQuestionAnalysisSchema
>;
export type StructuredReportAnalysisDto = Static<typeof StructuredReportAnalysisSchema>;
