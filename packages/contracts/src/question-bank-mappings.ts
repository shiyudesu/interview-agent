import {
  parseFollowUpGoalId,
  parseQuestionId,
  parseRubricItemId,
  type QuestionDefinition,
  type QuestionSnapshot,
  validateRubric,
} from "@interview-agent/domain";
import { ContractMappingError, checkDto, parseMappedDto } from "./mapping-validation.js";
import {
  type InternalQuestionSnapshotDto,
  InternalQuestionSnapshotSchema,
  type QuestionBankQuestionDto,
  QuestionBankQuestionSchema,
  validateQuestionBankQuestion,
} from "./question-bank.js";

interface SemanticQuestionValue {
  readonly sourceWording: string;
  readonly displayedWording?: string;
  readonly rubric: readonly {
    readonly id: string;
    readonly description: string;
    readonly weight: number;
  }[];
  readonly followUpGoals: readonly {
    readonly id: string;
    readonly kind: "clarification" | "depth";
    readonly goal: string;
  }[];
  readonly knowledgeExplanation: string;
}

function semanticQuestionIssues(value: SemanticQuestionValue): readonly {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}[] {
  const issues: { path: string; code: string; message: string }[] = [];
  const requireContent = (text: string, path: string, label: string) => {
    if (text.trim().length === 0) {
      issues.push({
        path,
        code: "blank_text",
        message: `${label} must contain non-whitespace text`,
      });
    }
  };

  requireContent(value.sourceWording, "/sourceWording", "Source wording");
  if (value.displayedWording !== undefined) {
    requireContent(value.displayedWording, "/displayedWording", "Displayed wording");
  }
  value.rubric.forEach((item, index) => {
    requireContent(item.description, `/rubric/${index}/description`, "Rubric description");
  });
  value.followUpGoals.forEach((goal, index) => {
    requireContent(goal.goal, `/followUpGoals/${index}/goal`, "Follow-up goal");
  });
  requireContent(value.knowledgeExplanation, "/knowledgeExplanation", "Knowledge explanation");

  try {
    validateRubric(
      value.rubric.map((item) => ({
        id: parseRubricItemId(item.id),
        description: item.description,
        weight: item.weight,
      })),
    );
  } catch (error) {
    issues.push({
      path: "/rubric",
      code: "invalid_rubric",
      message: error instanceof Error ? error.message : "Rubric is invalid",
    });
  }
  if (!value.followUpGoals.some((goal) => goal.kind === "clarification")) {
    issues.push({
      path: "/followUpGoals",
      code: "missing_clarification_goal",
      message: "At least one clarification follow-up goal is required",
    });
  }
  const goalIds = new Set<string>();
  for (const goal of value.followUpGoals) {
    if (goalIds.has(goal.id)) {
      issues.push({
        path: "/followUpGoals",
        code: "duplicate_follow_up_goal_id",
        message: `Follow-up goal ID ${goal.id} must be unique within a question`,
      });
    }
    goalIds.add(goal.id);
  }
  return issues;
}

export function mapQuestionBankQuestionDtoToDefinition(value: unknown): QuestionDefinition {
  const dto = checkDto(QuestionBankQuestionSchema, value, "question-bank question");
  const issues = validateQuestionBankQuestion(dto);
  if (issues.length > 0) {
    throw new ContractMappingError("question-bank question", issues);
  }

  return {
    questionId: parseQuestionId(dto.id),
    questionVersion: dto.contentVersion,
    domain: dto.domain,
    difficulty: dto.difficulty,
    questionType: dto.questionType,
    sourceWording: dto.sourceWording,
    rubric: dto.rubric.map((item) => ({
      id: parseRubricItemId(item.id),
      description: item.description,
      weight: item.weight,
    })),
    followUpGoals: dto.followUpGoals.map((goal) => ({
      id: parseFollowUpGoalId(goal.id),
      kind: goal.kind,
      goal: goal.goal,
    })),
    knowledgeExplanation: dto.knowledgeExplanation,
    active: dto.active,
    reviewed: dto.reviewed,
    reviewMetadata:
      dto.reviewMetadata === null
        ? null
        : {
            reviewedBy: dto.reviewMetadata.reviewedBy,
            reviewedAt: new Date(dto.reviewMetadata.reviewedAt),
            simplifiedChineseVerified: true,
            technicalTermsVerified: true,
          },
  };
}

export function mapQuestionDefinitionToQuestionBankDto(
  definition: QuestionDefinition,
): QuestionBankQuestionDto {
  const dto = parseMappedDto(
    QuestionBankQuestionSchema,
    {
      id: String(definition.questionId),
      contentVersion: definition.questionVersion,
      domain: definition.domain,
      difficulty: definition.difficulty,
      questionType: definition.questionType,
      sourceWording: definition.sourceWording,
      rubric: definition.rubric.map((item) => ({
        id: String(item.id),
        description: item.description,
        weight: item.weight,
      })),
      followUpGoals: definition.followUpGoals.map((goal) => ({
        id: String(goal.id),
        kind: goal.kind,
        goal: goal.goal,
      })),
      knowledgeExplanation: definition.knowledgeExplanation,
      active: definition.active,
      reviewed: definition.reviewed,
      reviewMetadata:
        definition.reviewMetadata === null
          ? null
          : {
              reviewedBy: definition.reviewMetadata.reviewedBy,
              reviewedAt: definition.reviewMetadata.reviewedAt.toISOString(),
              simplifiedChineseVerified: true,
              technicalTermsVerified: true,
            },
    },
    "question-bank question",
  );
  const issues = validateQuestionBankQuestion(dto);
  if (issues.length > 0) {
    throw new ContractMappingError("question-bank question", issues);
  }
  return dto;
}

export function mapQuestionDefinitionToSnapshot(
  definition: QuestionDefinition,
  displayedWording: string = definition.sourceWording,
): QuestionSnapshot {
  const snapshot: QuestionSnapshot = {
    questionId: definition.questionId,
    questionVersion: definition.questionVersion,
    domain: definition.domain,
    sourceWording: definition.sourceWording,
    displayedWording,
    rubric: definition.rubric.map((item) => ({ ...item })),
    followUpGoals: definition.followUpGoals.map((goal) => ({ ...goal })),
    knowledgeExplanation: definition.knowledgeExplanation,
  };
  const issues = semanticQuestionIssues(snapshot);
  if (issues.length > 0) {
    throw new ContractMappingError("question snapshot", issues);
  }
  return snapshot;
}

export function mapInternalQuestionSnapshotDtoToDomain(value: unknown): QuestionSnapshot {
  const dto = checkDto(InternalQuestionSnapshotSchema, value, "internal question snapshot");
  const issues = semanticQuestionIssues(dto);
  if (issues.length > 0) {
    throw new ContractMappingError("internal question snapshot", issues);
  }

  return {
    questionId: parseQuestionId(dto.questionId),
    questionVersion: dto.questionVersion,
    domain: dto.domain,
    sourceWording: dto.sourceWording,
    displayedWording: dto.displayedWording,
    rubric: dto.rubric.map((item) => ({
      id: parseRubricItemId(item.id),
      description: item.description,
      weight: item.weight,
    })),
    followUpGoals: dto.followUpGoals.map((goal) => ({
      id: parseFollowUpGoalId(goal.id),
      kind: goal.kind,
      goal: goal.goal,
    })),
    knowledgeExplanation: dto.knowledgeExplanation,
  };
}

export function mapQuestionSnapshotToInternalDto(
  snapshot: QuestionSnapshot,
): InternalQuestionSnapshotDto {
  const dto = parseMappedDto(
    InternalQuestionSnapshotSchema,
    {
      questionId: String(snapshot.questionId),
      questionVersion: snapshot.questionVersion,
      domain: snapshot.domain,
      sourceWording: snapshot.sourceWording,
      displayedWording: snapshot.displayedWording,
      rubric: snapshot.rubric.map((item) => ({
        id: String(item.id),
        description: item.description,
        weight: item.weight,
      })),
      followUpGoals: snapshot.followUpGoals.map((goal) => ({
        id: String(goal.id),
        kind: goal.kind,
        goal: goal.goal,
      })),
      knowledgeExplanation: snapshot.knowledgeExplanation,
    },
    "internal question snapshot",
  );
  const issues = semanticQuestionIssues(dto);
  if (issues.length > 0) {
    throw new ContractMappingError("internal question snapshot", issues);
  }
  return dto;
}
