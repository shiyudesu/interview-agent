import {
  createZeroQuestionOutcome,
  parseAnswerMaterialId,
  parseQuestionId,
  type ReportAnalysisResult,
} from "@interview-agent/domain";
import { describe, expect, it } from "vitest";
import { createZeroPointFeedbackText } from "../src/operation-report-builder.js";

const QUESTION = "请说明 Context 取消信号如何沿父子关系传播。";

function analysis(): ReportAnalysisResult["perQuestion"][number] {
  return {
    questionId: parseQuestionId("feedback-question"),
    answerSummary: "模型生成的泛化说明。",
    scoreRationale: "模型生成的泛化理由。",
    improvementSuggestions: ["模型建议继续复习。"],
    evidenceMaterialIds: [parseAnswerMaterialId("feedback-answer")],
  };
}

describe("zero-point report feedback", () => {
  it.each([
    {
      reason: "unknown",
      summary: "明确表示暂未掌握",
      rationale: "相关知识点尚未获得作答证据",
      suggestion: "学习后再用自己的话完整回答",
      keepsModelNarrative: false,
      questionField: "scoreRationale",
      suggestionCount: 1,
    },
    {
      reason: "skipped",
      summary: "主动选择跳过",
      rationale: "由于未作答",
      suggestion: "补做本题",
      keepsModelNarrative: false,
      questionField: "scoreRationale",
      suggestionCount: 1,
    },
    {
      reason: "irrelevant",
      summary: "没有回应",
      rationale: "偏离了问题要求",
      suggestion: "重新审题",
      keepsModelNarrative: true,
      questionField: "answerSummary",
      suggestionCount: 2,
    },
    {
      reason: "incorrect",
      summary: "存在错误理解",
      rationale: "需要纠正的具体概念",
      suggestion: "逐项纠正概念边界",
      keepsModelNarrative: true,
      questionField: null,
      suggestionCount: 2,
    },
  ] as const)(
    "guarantees tailored $reason guidance without generating a reference answer",
    ({
      reason,
      summary,
      rationale,
      suggestion,
      keepsModelNarrative,
      questionField,
      suggestionCount,
    }) => {
      const feedback = createZeroPointFeedbackText(
        createZeroQuestionOutcome(reason),
        QUESTION,
        analysis(),
      );

      expect(feedback.answerSummary).toContain(summary);
      expect(feedback.scoreRationale).toContain(rationale);
      if (questionField !== null) {
        expect(feedback[questionField]).toContain(QUESTION);
      }
      expect(feedback.improvementSuggestions[0]).toContain(suggestion);
      expect(feedback.improvementSuggestions).toHaveLength(suggestionCount);
      expect(feedback.answerSummary.includes("模型生成")).toBe(keepsModelNarrative);
      expect(feedback.scoreRationale.includes("模型生成")).toBe(keepsModelNarrative);
      expect(JSON.stringify(feedback).includes("模型建议")).toBe(keepsModelNarrative);
      expect(JSON.stringify(feedback)).not.toContain("参考答案");
    },
  );
});
