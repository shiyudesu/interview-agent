import {
  type Context,
  type FauxResponseFactory,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import {
  type AnswerMaterial,
  type InterviewerTextEvent,
  type InterviewerTextRequest,
  parseAnswerMaterialId,
  parseFollowUpGoalId,
  parseQuestionId,
  parseRubricItemId,
  type QuestionSnapshot,
} from "@interview-agent/domain";
import { describe, expect, it } from "vitest";

import {
  InterviewerTextModelError,
  MAX_INTERVIEWER_ANSWER_MATERIAL_CHARACTERS,
  MAX_INTERVIEWER_ANSWER_MATERIAL_ITEMS,
  PiAgentInterviewerTextModel,
} from "../src/interviewer-text-model.js";
import {
  CURRENT_MODEL_PROMPT_VERSIONS,
  CURRENT_MODEL_SCHEMA_VERSIONS,
} from "../src/model-contract-registry.js";
import { createModelRuntime, type FauxModelRuntime } from "../src/model-runtime.js";

const selectedGoal = {
  id: parseFollowUpGoalId("goal-depth"),
  kind: "depth",
  goal: "确认候选人是否理解父子 Context 之间的取消传播",
} as const;

const question: QuestionSnapshot = {
  questionId: parseQuestionId("go-context-cancellation"),
  questionVersion: 7,
  domain: "go_language",
  sourceWording: "请说明 context.Context 的取消信号如何在父子 Context 之间传播。",
  displayedWording: "请谈谈 context.Context 的取消信号如何影响派生 Context。",
  rubric: [
    {
      id: parseRubricItemId("rubric-propagation"),
      description: "说明取消信号会沿派生 Context 传播",
      weight: 60,
    },
    {
      id: parseRubricItemId("rubric-done"),
      description: "说明 Done channel 会被关闭",
      weight: 40,
    },
  ],
  followUpGoals: [
    selectedGoal,
    {
      id: parseFollowUpGoalId("goal-unselected"),
      kind: "clarification",
      goal: "UNSELECTED_GOAL_SECRET",
    },
  ],
  knowledgeExplanation: "KNOWLEDGE_EXPLANATION_SECRET",
};

const answerMaterial: readonly AnswerMaterial[] = [
  {
    id: parseAnswerMaterialId("answer-main"),
    kind: "main_answer",
    text: "它通过关闭 Done channel 传递取消信号。",
    submittedAt: new Date("2026-08-11T10:00:00.000Z"),
  },
  {
    id: parseAnswerMaterialId("answer-supplement"),
    kind: "supplement",
    text: "子 Context 会观察父 Context 的取消状态。",
    submittedAt: new Date("2026-08-11T10:01:00.000Z"),
  },
];

const rephraseRequest = {
  purpose: "rephrase_question",
  question,
} as const satisfies InterviewerTextRequest;

const clarificationRequest = {
  purpose: "clarify_question",
  question,
} as const satisfies InterviewerTextRequest;

const followUpRequest = {
  purpose: "phrase_follow_up",
  question,
  goal: selectedGoal,
  followUpPurpose: "depth",
  answerMaterial,
} as const satisfies InterviewerTextRequest;

async function fauxRuntime(modelId = "interviewer-test-model"): Promise<FauxModelRuntime> {
  const runtime = await createModelRuntime({
    provider: "faux",
    id: modelId,
  });
  if (runtime.kind !== "faux") {
    throw new Error("Expected a Faux Provider runtime");
  }
  return runtime;
}

async function collectEvents(
  events: AsyncIterable<InterviewerTextEvent>,
): Promise<readonly InterviewerTextEvent[]> {
  const collected: InterviewerTextEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

function completedEvent(events: readonly InterviewerTextEvent[]) {
  const completed = events.at(-1);
  if (completed?.type !== "completed") {
    throw new Error("Expected a completed interviewer text event");
  }
  return completed;
}

function userPrompt(context: Context): string {
  expect(context.messages).toHaveLength(1);
  const message = context.messages[0];
  if (message?.role !== "user") {
    throw new Error("Expected one user prompt");
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content
    .filter((content) => content.type === "text")
    .map(({ text }) => text)
    .join("");
}

function decodeBlock(prompt: string, blockName: string): unknown {
  const opening = `<${blockName} encoding="base64url-json">`;
  const closing = `</${blockName}>`;
  const start = prompt.indexOf(opening);
  const end = prompt.indexOf(closing);
  if (start < 0 || end < 0) {
    throw new Error(`Missing ${blockName} block`);
  }
  const encoded = prompt.slice(start + opening.length, end).trim();
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
}

describe("PiAgentInterviewerTextModel", () => {
  it("emits validated text deltas followed by exactly one completed event", async () => {
    const runtime = await fauxRuntime();
    const output = "请说明 context.Context 的取消信号如何在父子 Context 之间进行传播。";
    runtime.faux.setResponses([fauxAssistantMessage(output)]);
    const adapter = new PiAgentInterviewerTextModel(runtime);

    const events = await collectEvents(adapter.stream(rephraseRequest));
    const deltas = events.filter((event) => event.type === "delta");
    const completed = completedEvent(events);

    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map(({ text }) => text).join("")).toBe(output);
    expect(events.filter(({ type }) => type === "completed")).toHaveLength(1);
    expect(completed.text).toBe(output);
  });

  it("builds a fresh bounded context for each purpose and registers no tools", async () => {
    const runtime = await fauxRuntime();
    const contexts: Context[] = [];
    const capture =
      (output: string): FauxResponseFactory =>
      (context) => {
        contexts.push(structuredClone(context));
        return fauxAssistantMessage(output);
      };
    runtime.faux.setResponses([
      capture("请说明 context.Context 的取消信号如何影响派生 Context。"),
      capture("这个问题关注父子 Context 之间取消信号的传播范围。"),
      capture("父子 Context 之间的取消信号是如何传播的？"),
    ]);
    const adapter = new PiAgentInterviewerTextModel(runtime);

    await collectEvents(adapter.stream(rephraseRequest));
    await collectEvents(adapter.stream(clarificationRequest));
    await collectEvents(adapter.stream(followUpRequest));

    expect(contexts).toHaveLength(3);
    for (const context of contexts) {
      expect(context.tools).toEqual([]);
      expect(context.messages).toHaveLength(1);
    }

    const rephrasePrompt = userPrompt(contexts[0] as Context);
    expect(rephrasePrompt).toContain(`sourceWording=${JSON.stringify(question.sourceWording)}`);
    for (const rubric of question.rubric) {
      expect(rephrasePrompt).not.toContain(rubric.id);
      expect(rephrasePrompt).not.toContain(rubric.description);
    }
    expect(rephrasePrompt).not.toContain(question.displayedWording);
    expect(rephrasePrompt).not.toContain(selectedGoal.goal);
    expect(rephrasePrompt).not.toContain(question.knowledgeExplanation);

    const clarificationPrompt = userPrompt(contexts[1] as Context);
    expect(decodeBlock(clarificationPrompt, "UNTRUSTED_MODEL_CONTENT")).toBe(
      question.displayedWording,
    );
    expect(clarificationPrompt).not.toContain(question.displayedWording);
    expect(clarificationPrompt).not.toContain(selectedGoal.goal);
    expect(clarificationPrompt).not.toContain(question.knowledgeExplanation);

    const followUpPrompt = userPrompt(contexts[2] as Context);
    expect(followUpPrompt).toContain(`selectedGoal=${JSON.stringify(selectedGoal)}`);
    expect(followUpPrompt).toContain(`followUpPurpose=${JSON.stringify("depth")}`);
    expect(decodeBlock(followUpPrompt, "UNTRUSTED_USER_CONTENT")).toEqual(
      answerMaterial.map(({ id, kind, text }) => ({ id, kind, text })),
    );
    expect(followUpPrompt).not.toContain(answerMaterial[0]?.text);
    expect(followUpPrompt).not.toContain(answerMaterial[0]?.submittedAt.toISOString());
    expect(followUpPrompt).not.toContain("UNSELECTED_GOAL_SECRET");
    expect(followUpPrompt).not.toContain(question.knowledgeExplanation);
  });

  it.each([
    {
      name: "registered text Schema",
      request: clarificationRequest,
      output: "请".repeat(2_001),
    },
    {
      name: "Traditional Chinese",
      request: clarificationRequest,
      output: "請說明父 Context 取消後的傳播行為。",
    },
    {
      name: "Rubric leakage",
      request: clarificationRequest,
      output: "评分点：说明取消信号会沿派生 Context 传播。",
    },
    {
      name: "answer-material leakage",
      request: followUpRequest,
      output: "你刚才说它通过关闭 Done channel 传递取消信号，对吗？",
    },
    {
      name: "multiple follow-up questions",
      request: followUpRequest,
      output: "父 Context 取消后会怎样？派生 Context 又会怎样？",
    },
    {
      name: "unrelated clarification",
      request: clarificationRequest,
      output: "这个问题主要讨论 Go GC 的暂停时间。",
    },
    {
      name: "unrelated selected-goal follow-up",
      request: followUpRequest,
      output: "Go GC 在什么时候开始并发标记？",
    },
  ])("rejects invalid $name output explicitly", async ({ request, output }) => {
    const runtime = await fauxRuntime();
    runtime.faux.setResponses([fauxAssistantMessage(output)]);
    const adapter = new PiAgentInterviewerTextModel(runtime);
    const events: InterviewerTextEvent[] = [];

    await expect(
      (async () => {
        for await (const event of adapter.stream(request)) {
          events.push(event);
        }
      })(),
    ).rejects.toMatchObject({
      name: "InterviewerTextModelError",
      code: "invalid_output",
      metadata: {
        provider: "faux",
        modelId: "interviewer-test-model",
        purpose: request.purpose,
        questionVersion: 7,
      },
    });
    expect(events).toEqual([]);
  });

  it.each([clarificationRequest, followUpRequest])(
    "emits no events when %s provider work fails",
    async (request) => {
      const runtime = await fauxRuntime();
      runtime.faux.setResponses([
        fauxAssistantMessage("不应泄漏的部分输出", {
          stopReason: "error",
          errorMessage: "503 service unavailable",
        }),
      ]);
      const adapter = new PiAgentInterviewerTextModel(runtime);
      const events: InterviewerTextEvent[] = [];

      await expect(
        (async () => {
          for await (const event of adapter.stream(request)) {
            events.push(event);
          }
        })(),
      ).rejects.toMatchObject({ code: "model_call_failed" });
      expect(events).toEqual([]);
    },
  );

  it("returns reviewed source wording for both failed and invalid rephrasing attempts", async () => {
    const runtime = await fauxRuntime("configured-fallback-model");
    runtime.faux.setResponses([
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "scripted provider failure",
      }),
      fauxAssistantMessage("請改寫這個問題。"),
      fauxAssistantMessage("请解释 Go GC 如何降低暂停时间。"),
      fauxAssistantMessage("取消信号应如何传播？"),
    ]);
    const adapter = new PiAgentInterviewerTextModel(runtime);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const events = await collectEvents(adapter.stream(rephraseRequest));
      expect(events).toEqual([
        { type: "delta", text: question.sourceWording },
        {
          type: "completed",
          text: question.sourceWording,
          metadata: expect.objectContaining({
            provider: "faux",
            modelId: "configured-fallback-model",
            promptVersion: CURRENT_MODEL_PROMPT_VERSIONS.rephrase_question,
            schemaVersion: CURRENT_MODEL_SCHEMA_VERSIONS.rephrase_question,
            questionVersion: 7,
            purpose: "rephrase_question",
          }),
        },
      ]);
    }
  });

  it("rejects answer material that exceeds deterministic context budgets", async () => {
    const runtime = await fauxRuntime();
    const adapter = new PiAgentInterviewerTextModel(runtime);
    const tooManyItems = Array.from(
      { length: MAX_INTERVIEWER_ANSWER_MATERIAL_ITEMS + 1 },
      (_, index): AnswerMaterial => ({
        id: parseAnswerMaterialId(`answer-${index}`),
        kind: "supplement",
        text: "补充内容",
        submittedAt: new Date("2026-08-11T10:00:00.000Z"),
      }),
    );
    const tooMuchText: readonly AnswerMaterial[] = [
      {
        id: parseAnswerMaterialId("answer-large"),
        kind: "main_answer",
        text: "答".repeat(MAX_INTERVIEWER_ANSWER_MATERIAL_CHARACTERS + 1),
        submittedAt: new Date("2026-08-11T10:00:00.000Z"),
      },
    ];

    for (const oversized of [tooManyItems, tooMuchText]) {
      expect(() =>
        adapter.stream({
          ...followUpRequest,
          answerMaterial: oversized,
        }),
      ).toThrowError(new InterviewerTextModelError("invalid_request", null));
    }
    expect(runtime.faux.getPendingResponseCount()).toBe(0);
  });

  it("attaches server-owned configured model and registry metadata", async () => {
    const runtime = await fauxRuntime("metadata-model");
    runtime.faux.setResponses([fauxAssistantMessage("父子 Context 之间的取消信号是如何传播的？")]);
    const adapter = new PiAgentInterviewerTextModel(runtime);

    const completed = completedEvent(await collectEvents(adapter.stream(followUpRequest)));

    expect(completed.metadata).toEqual({
      provider: "faux",
      modelId: "metadata-model",
      promptVersion: CURRENT_MODEL_PROMPT_VERSIONS.phrase_follow_up,
      schemaVersion: CURRENT_MODEL_SCHEMA_VERSIONS.phrase_follow_up,
      questionVersion: 7,
      purpose: "phrase_follow_up",
      latencyMs: expect.any(Number),
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
    });
    expect(completed.metadata.latencyMs).toBeGreaterThanOrEqual(0);
    expect(completed.metadata.inputTokens).toBeGreaterThan(0);
    expect(completed.metadata.outputTokens).toBeGreaterThan(0);
  });
});
