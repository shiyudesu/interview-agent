import { type Static, Type } from "typebox";
import { Check, Errors } from "typebox/value";

import {
  FollowUpGoalIdSchema,
  IsoTimestampSchema,
  KnowledgeDomainSchema,
  PositiveVersionSchema,
  QuestionIdSchema,
  RubricItemIdSchema,
} from "./common.js";
import { FollowUpKindSchema } from "./evaluation.js";

export const QuestionBankRubricItemSchema = Type.Object(
  {
    id: RubricItemIdSchema,
    description: Type.String({ minLength: 1 }),
    weight: Type.Integer({ minimum: 1, maximum: 100 }),
  },
  { additionalProperties: false },
);

export const QuestionBankFollowUpGoalSchema = Type.Object(
  {
    id: FollowUpGoalIdSchema,
    kind: FollowUpKindSchema,
    goal: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const QuestionBankQuestionSchema = Type.Object(
  {
    id: QuestionIdSchema,
    version: PositiveVersionSchema,
    domain: KnowledgeDomainSchema,
    difficulty: Type.Literal("medium"),
    sourceWording: Type.String({ minLength: 1 }),
    rubric: Type.Array(QuestionBankRubricItemSchema, { minItems: 1, uniqueItems: true }),
    followUpGoals: Type.Array(QuestionBankFollowUpGoalSchema, {
      minItems: 1,
      uniqueItems: true,
    }),
    knowledgeExplanation: Type.String({ minLength: 1 }),
    active: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const QuestionBankSourceSchema = Type.Object(
  {
    schemaVersion: Type.Literal("1.0"),
    questions: Type.Array(QuestionBankQuestionSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export const QuestionBankImportSchema = Type.Object(
  {
    schemaVersion: Type.Literal("1.0"),
    sourceName: Type.String({ minLength: 1 }),
    sourceVersion: PositiveVersionSchema,
    importedAt: IsoTimestampSchema,
    questions: Type.Array(QuestionBankQuestionSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export const InternalQuestionSnapshotSchema = Type.Object(
  {
    questionId: QuestionIdSchema,
    questionVersion: PositiveVersionSchema,
    domain: KnowledgeDomainSchema,
    sourceWording: Type.String({ minLength: 1 }),
    displayedWording: Type.String({ minLength: 1 }),
    rubric: Type.Array(QuestionBankRubricItemSchema, { minItems: 1 }),
    followUpGoals: Type.Array(QuestionBankFollowUpGoalSchema, { minItems: 1 }),
    knowledgeExplanation: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export interface QuestionBankValidationIssue {
  readonly path: string;
  readonly code:
    | "schema"
    | "rubric_total"
    | "duplicate_rubric_item_id"
    | "duplicate_follow_up_goal_id"
    | "missing_clarification_goal";
  readonly message: string;
}

export function validateQuestionBankQuestion(
  value: unknown,
): readonly QuestionBankValidationIssue[] {
  if (!Check(QuestionBankQuestionSchema, value)) {
    return [...Errors(QuestionBankQuestionSchema, value)].map((error) => ({
      path: error.instancePath || "/",
      code: "schema" as const,
      message: error.message,
    }));
  }

  const issues: QuestionBankValidationIssue[] = [];
  const totalWeight = value.rubric.reduce((total, item) => total + item.weight, 0);
  if (totalWeight !== 100) {
    issues.push({
      path: "/rubric",
      code: "rubric_total",
      message: `Rubric weights must total 100, received ${totalWeight}`,
    });
  }

  for (const [items, path, code, label] of [
    [value.rubric, "/rubric", "duplicate_rubric_item_id", "Rubric item"],
    [value.followUpGoals, "/followUpGoals", "duplicate_follow_up_goal_id", "Follow-up goal"],
  ] as const) {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.id)) {
        issues.push({
          path,
          code,
          message: `${label} ID ${item.id} must be unique within a question`,
        });
      }
      seen.add(item.id);
    }
  }

  if (!value.followUpGoals.some((goal) => goal.kind === "clarification")) {
    issues.push({
      path: "/followUpGoals",
      code: "missing_clarification_goal",
      message: "At least one clarification follow-up goal is required",
    });
  }

  return issues;
}

export type QuestionBankRubricItemDto = Static<typeof QuestionBankRubricItemSchema>;
export type QuestionBankFollowUpGoalDto = Static<typeof QuestionBankFollowUpGoalSchema>;
export type QuestionBankQuestionDto = Static<typeof QuestionBankQuestionSchema>;
export type QuestionBankSourceDto = Static<typeof QuestionBankSourceSchema>;
export type QuestionBankImportDto = Static<typeof QuestionBankImportSchema>;
export type InternalQuestionSnapshotDto = Static<typeof InternalQuestionSnapshotSchema>;
