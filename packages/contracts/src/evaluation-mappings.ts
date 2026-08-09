import {
  deriveEvaluatedQuestionOutcome,
  type FollowUpRecommendation,
  InvalidRubricAwardError,
  type ModelCallMetadata,
  parseAnswerMaterialId,
  parseEvaluationId,
  parseFollowUpGoalId,
  parseRubricItemId,
  type QuestionEvaluation,
  type QuestionEvaluationInput,
} from "@interview-agent/domain";

import {
  type InternalQuestionEvaluationDto,
  InternalQuestionEvaluationSchema,
  type ModelCallMetadataDto,
  ModelCallMetadataSchema,
  StructuredAnswerEvaluationSchema,
} from "./evaluation.js";
import { ContractMappingError, checkDto, parseMappedDto } from "./mapping-validation.js";

export interface TrustedEvaluationContext {
  readonly evaluationId: string;
  readonly expectedQuestionVersion: number;
  readonly expectedPurpose: "answer_evaluation";
  readonly metadata: ModelCallMetadata;
}

export interface TrustedAnswerEvaluationContext {
  readonly expectedQuestionVersion: number;
  readonly expectedPurpose: "answer_evaluation";
  readonly metadata: ModelCallMetadata;
}

export interface MappedStructuredAnswerEvaluation {
  readonly evaluation: QuestionEvaluationInput;
  readonly recommendedFollowUp: FollowUpRecommendation | null;
  readonly metadata: ModelCallMetadata;
}

export function mapModelCallMetadataToDto(metadata: ModelCallMetadata): ModelCallMetadataDto {
  return parseMappedDto(
    ModelCallMetadataSchema,
    {
      provider: metadata.provider,
      modelId: metadata.modelId,
      promptVersion: metadata.promptVersion,
      schemaVersion: metadata.schemaVersion,
      questionVersion: metadata.questionVersion,
      purpose: metadata.purpose,
      latencyMs: metadata.latencyMs,
      tokens: {
        inputTokens: metadata.inputTokens,
        outputTokens: metadata.outputTokens,
      },
    },
    "model call metadata",
  );
}

function normalizeTrustedAnswerEvaluationMetadata(
  context: TrustedAnswerEvaluationContext,
): ModelCallMetadata {
  if (
    context.metadata.questionVersion !== context.expectedQuestionVersion ||
    context.metadata.purpose !== context.expectedPurpose
  ) {
    throw new ContractMappingError("trusted evaluation context", [
      {
        path: "/metadata",
        code: "invalid_trusted_model_metadata",
        message: "Trusted model-call metadata does not match the expected evaluation context",
      },
    ]);
  }
  const metadata = {
    ...context.metadata,
    questionVersion: context.expectedQuestionVersion,
    purpose: context.expectedPurpose,
  };
  mapModelCallMetadataToDto(metadata);
  return metadata;
}

export function mapStructuredAnswerEvaluationDto(
  value: unknown,
  context: TrustedEvaluationContext,
): MappedStructuredAnswerEvaluation {
  const dto = checkDto(StructuredAnswerEvaluationSchema, value, "structured answer evaluation");
  if (
    dto.metadata.questionVersion !== context.expectedQuestionVersion ||
    dto.metadata.purpose !== context.expectedPurpose
  ) {
    throw new ContractMappingError("structured answer evaluation", [
      {
        path: "/metadata",
        code: "mismatched_model_metadata",
        message: "Evaluation metadata does not match the trusted model-call context",
      },
    ]);
  }
  const metadata = normalizeTrustedAnswerEvaluationMetadata(context);
  return {
    evaluation: {
      id: parseEvaluationId(context.evaluationId),
      classification: dto.classification,
      rubricItems: dto.rubricItems.map((item) => ({
        rubricItemId: parseRubricItemId(item.rubricItemId),
        evidenceMaterialIds: item.evidenceMaterialIds.map(parseAnswerMaterialId),
        awardedPoints: item.awardedPoints,
        missingOrIncorrectPoints: [...item.missingOrIncorrectPoints],
      })),
    },
    recommendedFollowUp:
      dto.recommendedFollowUp === null
        ? null
        : {
            goalId: parseFollowUpGoalId(dto.recommendedFollowUp.goalId),
            kind: dto.recommendedFollowUp.kind,
            purpose: dto.recommendedFollowUp.purpose,
          },
    metadata,
  };
}

export function mapQuestionEvaluationToInternalDto(
  evaluation: QuestionEvaluation,
  context: TrustedAnswerEvaluationContext,
): InternalQuestionEvaluationDto {
  const metadata = normalizeTrustedAnswerEvaluationMetadata(context);
  let outcome: QuestionEvaluation["outcome"];
  try {
    outcome = deriveEvaluatedQuestionOutcome(evaluation);
  } catch (error) {
    if (error instanceof InvalidRubricAwardError) {
      throw new ContractMappingError("question evaluation", [
        {
          path: "/rubricItems",
          code: error.code,
          message: error.message,
        },
      ]);
    }
    throw error;
  }
  return parseMappedDto(
    InternalQuestionEvaluationSchema,
    {
      evaluationId: String(evaluation.id),
      classification: evaluation.classification,
      rubricItems: evaluation.rubricItems.map((item) => ({
        rubricItemId: String(item.rubricItemId),
        evidenceMaterialIds: item.evidenceMaterialIds.map(String),
        awardedPoints: item.awardedPoints,
        missingOrIncorrectPoints: [...item.missingOrIncorrectPoints],
      })),
      outcome:
        outcome.kind === "scored"
          ? {
              kind: "scored",
              score: outcome.score,
            }
          : {
              kind: outcome.kind,
              score: 0,
              zeroScoreReason: outcome.zeroScoreReason,
            },
      metadata: mapModelCallMetadataToDto(metadata),
    },
    "internal question evaluation",
  );
}
