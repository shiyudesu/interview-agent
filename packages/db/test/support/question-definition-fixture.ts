import {
  type KnowledgeDomain,
  parseFollowUpGoalId,
  parseQuestionId,
  parseRubricItemId,
  type QuestionDefinition,
  type QuestionType,
} from "@interview-agent/domain";

export interface QuestionDefinitionFixtureInput {
  readonly active?: boolean;
  readonly contentVersion: number;
  readonly domain?: KnowledgeDomain;
  readonly id: string;
  readonly knowledgeExplanation?: string;
  readonly questionType?: QuestionType;
  readonly reviewed?: boolean;
  readonly sourceWording?: string;
}

export function questionDefinitionFixture(
  input: QuestionDefinitionFixtureInput,
): QuestionDefinition {
  const reviewed = input.reviewed ?? true;
  return {
    questionId: parseQuestionId(input.id),
    questionVersion: input.contentVersion,
    domain: input.domain ?? "go_language",
    difficulty: "medium",
    questionType: input.questionType ?? "conceptual",
    sourceWording:
      input.sourceWording ??
      `请解释 Go context 取消信号如何传播，以及调用方如何响应，版本 ${input.contentVersion}。`,
    rubric: [
      {
        id: parseRubricItemId("propagation"),
        description: "说明取消信号沿派生 Context 传播",
        weight: 60,
      },
      {
        id: parseRubricItemId("cleanup"),
        description: "说明调用方观察 Done 并释放资源",
        weight: 40,
      },
    ],
    followUpGoals: [
      {
        id: parseFollowUpGoalId("clarify"),
        kind: "clarification",
        goal: "澄清取消信号传播的调用链范围",
      },
      {
        id: parseFollowUpGoalId("depth"),
        kind: "depth",
        goal: "说明 goroutine 如何及时退出",
      },
    ],
    knowledgeExplanation:
      input.knowledgeExplanation ??
      "Context 通过 Done 通道传播取消，相关 goroutine 应及时停止工作。",
    active: input.active ?? true,
    reviewed,
    reviewMetadata: reviewed
      ? {
          reviewedBy: "reviewer-id",
          reviewedAt: new Date("2026-08-10T00:00:00.000Z"),
          simplifiedChineseVerified: true,
          technicalTermsVerified: true,
        }
      : null,
  };
}
