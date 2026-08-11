import {
  type Context,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxToolCall,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { ModelAnswerEvaluationOutputSchema } from "@interview-agent/contracts";
import {
  type AnswerEvaluationRequest,
  type AnswerMaterial,
  parseAnswerMaterialId,
  parseEvaluationId,
  parseFollowUpGoalId,
  scoreQuestion,
} from "@interview-agent/domain";
import { describe, expect, it } from "vitest";

import {
  AnswerEvaluationModelError,
  MAX_EVALUATION_ANSWER_MATERIAL_ITEMS,
  MAX_MISSING_OR_INCORRECT_POINT_CHARACTERS,
  PiAnswerEvaluationModel,
} from "../src/answer-evaluation-model.js";
import {
  CURRENT_MODEL_PROMPT_VERSIONS,
  CURRENT_MODEL_SCHEMA_VERSIONS,
} from "../src/model-contract-registry.js";
import { createModelRuntime, type FauxModelRuntime } from "../src/model-runtime.js";
import {
  createFixtureEvaluationRequest,
  getModelEvaluatedEvaluationFixture,
  MODEL_EVALUATED_EVALUATION_FIXTURES,
} from "./fixtures/evaluation-fixtures.js";

const OUTPUT_TOOL_NAME = "submit_answer_evaluation";

const correctFixture = getModelEvaluatedEvaluationFixture("evaluation.context.correct");
const promptInjectionFixture = getModelEvaluatedEvaluationFixture(
  "evaluation.context.prompt-injection",
);
const request = createFixtureEvaluationRequest(correctFixture);
const fullAwards = correctFixture.modelOutput.rubricItems;

const partialAwards = [
  {
    rubricItemId: "rubric-propagation",
    evidenceMaterialIds: ["answer-main"],
    awardedPoints: 40,
    missingOrIncorrectPoints: ["没有完整说明取消只会从父 Context 向派生 Context 传播"],
  },
  {
    rubricItemId: "rubric-done",
    evidenceMaterialIds: ["answer-supplement"],
    awardedPoints: 20,
    missingOrIncorrectPoints: ["没有说明 Done channel 关闭与 Err 返回值之间的关系"],
  },
] as const;

const zeroAwards = [
  {
    rubricItemId: "rubric-propagation",
    evidenceMaterialIds: [],
    awardedPoints: 0,
    missingOrIncorrectPoints: ["没有说明取消信号的传播方向"],
  },
  {
    rubricItemId: "rubric-done",
    evidenceMaterialIds: [],
    awardedPoints: 0,
    missingOrIncorrectPoints: ["没有说明 Done channel 会关闭"],
  },
] as const;

function structuredResponse(output: unknown) {
  return fauxAssistantMessage(fauxToolCall(OUTPUT_TOOL_NAME, output as Record<string, unknown>), {
    stopReason: "toolUse",
  });
}

async function fauxRuntime(modelId = "answer-evaluation-test-model"): Promise<FauxModelRuntime> {
  const runtime = await createModelRuntime({
    provider: "faux",
    id: modelId,
  });
  if (runtime.kind !== "faux") {
    throw new Error("Expected a Faux Provider runtime");
  }
  return runtime;
}

function userPrompt(context: Context): string {
  expect(context.messages).toHaveLength(1);
  const message = context.messages[0];
  if (message?.role !== "user") {
    throw new Error("Expected one user prompt");
  }
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((content) => content.type === "text")
        .map(({ text }) => text)
        .join("");
}

function decodeLastBlock(prompt: string, blockName: string): unknown {
  const opening = `<${blockName} encoding="base64url-json">`;
  const closing = `</${blockName}>`;
  const start = prompt.lastIndexOf(opening);
  const end = prompt.indexOf(closing, start);
  if (start < 0 || end < 0) {
    throw new Error(`Missing ${blockName} block`);
  }
  const encoded = prompt.slice(start + opening.length, end).trim();
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
}

describe("PiAnswerEvaluationModel", () => {
  it.each(
    MODEL_EVALUATED_EVALUATION_FIXTURES.map((fixture) => ({
      name: fixture.category,
      fixture,
    })),
  )(
    "returns the validated $name fixture without calculating or persisting state",
    async ({ fixture }) => {
      const runtime = await fauxRuntime();
      runtime.faux.setResponses([structuredResponse(fixture.modelOutput)]);
      const adapter = new PiAnswerEvaluationModel(runtime);

      const fixtureRequest = createFixtureEvaluationRequest(fixture);
      const result = await adapter.evaluate(fixtureRequest);
      const evaluation = scoreQuestion({
        rubric: fixture.question.rubric,
        evaluation: {
          id: parseEvaluationId(`${fixture.caseId}.test`),
          classification: result.classification,
          rubricItems: result.rubricItems,
        },
        validEvidenceMaterialIds: new Set(fixture.answerMaterial.map(({ id }) => id)),
      });

      expect(result.classification).toBe(fixture.expected.classification);
      expect(evaluation.outcome).toEqual(fixture.expected.outcome);
      expect(result.recommendedFollowUpGoal).toEqual(fixture.expected.recommendedFollowUpGoal);
      expect(runtime.faux.getPendingResponseCount()).toBe(0);
    },
  );

  it("accepts the mandatory first-irrelevant clarification recommendation", async () => {
    const runtime = await fauxRuntime();
    runtime.faux.setResponses([
      structuredResponse({
        classification: "irrelevant",
        rubricItems: zeroAwards,
        recommendedFollowUp: {
          goalId: "goal-clarification",
          kind: "clarification",
          purpose: "irrelevant_response_clarification",
        },
      }),
    ]);
    const adapter = new PiAnswerEvaluationModel(runtime);

    await expect(adapter.evaluate(request)).resolves.toMatchObject({
      classification: "irrelevant",
      recommendedFollowUpGoal: {
        goalId: "goal-clarification",
        kind: "clarification",
        purpose: "irrelevant_response_clarification",
      },
    });
  });

  it("separates trusted snapshot facts from complete Base64URL-framed untrusted answers", async () => {
    const runtime = await fauxRuntime();
    let capturedContext: Context | undefined;
    let capturedOptions: SimpleStreamOptions | undefined;
    const capture: FauxResponseFactory = (context, options) => {
      capturedContext = context;
      capturedOptions = options;
      return structuredResponse(promptInjectionFixture.modelOutput);
    };
    runtime.faux.setResponses([capture]);
    const adapter = new PiAnswerEvaluationModel(runtime);

    await adapter.evaluate(createFixtureEvaluationRequest(promptInjectionFixture));

    if (capturedContext === undefined) {
      throw new Error("Expected the Faux Provider to capture a context");
    }
    const prompt = userPrompt(capturedContext);
    expect(prompt).toContain(
      `questionId=${JSON.stringify(promptInjectionFixture.question.questionId)}`,
    );
    expect(prompt).toContain(`rubric=${JSON.stringify(promptInjectionFixture.question.rubric)}`);
    expect(prompt).toContain(
      `predefinedFollowUpGoals=${JSON.stringify(promptInjectionFixture.question.followUpGoals)}`,
    );
    expect(prompt).toContain(`usedFollowUpGoalIds=${JSON.stringify([])}`);
    for (const material of promptInjectionFixture.answerMaterial) {
      expect(prompt).not.toContain(material.text);
    }
    for (const injectionString of promptInjectionFixture.untrustedInputStrings) {
      expect(prompt).not.toContain(injectionString);
    }
    expect(prompt).not.toContain(promptInjectionFixture.question.knowledgeExplanation);
    expect(decodeLastBlock(prompt, "UNTRUSTED_USER_CONTENT")).toEqual(
      promptInjectionFixture.answerMaterial.map(({ id, kind, text }) => ({ id, kind, text })),
    );
    expect(capturedContext.tools).toHaveLength(1);
    expect(capturedContext.tools?.[0]).toMatchObject({
      name: OUTPUT_TOOL_NAME,
      parameters: ModelAnswerEvaluationOutputSchema,
      constrainedSampling: {
        type: "json_schema",
        strict: "prefer",
      },
    });
    expect(capturedOptions).toMatchObject({ maxRetries: 0 });
  });

  it("performs one directed repair with sanitized issues and invalid output framed as untrusted", async () => {
    const runtime = await fauxRuntime();
    const contexts: Context[] = [];
    const invalidOutput = {
      classification: "relevant",
      rubricItems: [
        {
          rubricItemId: "rubric-propagation",
          evidenceMaterialIds: ["invented-answer"],
          awardedPoints: 60,
          missingOrIncorrectPoints: [],
        },
        {
          rubricItemId: "rubric-done",
          evidenceMaterialIds: ["answer-supplement"],
          awardedPoints: 40,
          missingOrIncorrectPoints: [],
        },
      ],
      recommendedFollowUp: {
        goalId: "goal-used",
        kind: "clarification",
        purpose: "answer_clarification",
      },
    };
    const capture =
      (output: unknown): FauxResponseFactory =>
      (context) => {
        contexts.push(context);
        return structuredResponse(output);
      };
    runtime.faux.setResponses([
      capture(invalidOutput),
      capture({
        classification: "relevant",
        rubricItems: fullAwards,
        recommendedFollowUp: null,
      }),
    ]);
    const adapter = new PiAnswerEvaluationModel(runtime);

    const result = await adapter.evaluate(request);

    expect(result.rubricItems.map(({ awardedPoints }) => awardedPoints)).toEqual([60, 40]);
    expect(contexts).toHaveLength(2);
    const repairPrompt = userPrompt(contexts[1] as Context);
    expect(repairPrompt).toContain("<TRUSTED_STRUCTURE_REPAIR>");
    expect(repairPrompt).toContain("unknown_evidence_id");
    expect(repairPrompt).not.toContain("invented-answer");
    expect(decodeLastBlock(repairPrompt, "UNTRUSTED_MODEL_CONTENT")).toEqual({
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          name: OUTPUT_TOOL_NAME,
          arguments: invalidOutput,
        },
      ],
    });
  });

  it("aggregates wrong-tool, schema, and domain issues into the single repair", async () => {
    const runtime = await fauxRuntime();
    const contexts: Context[] = [];
    runtime.faux.setResponses([
      (context) => {
        contexts.push(context);
        return fauxAssistantMessage(
          fauxToolCall("wrong-tool", {
            classification: "relevant",
            recommendedFollowUp: null,
          }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        contexts.push(context);
        return structuredResponse({
          classification: "relevant",
          rubricItems: fullAwards,
          recommendedFollowUp: null,
        });
      },
    ]);
    const adapter = new PiAnswerEvaluationModel(runtime);

    await expect(adapter.evaluate(request)).resolves.toMatchObject({
      classification: "relevant",
    });
    const repairPrompt = userPrompt(contexts[1] as Context);
    expect(repairPrompt).toContain("wrong_tool");
    expect(repairPrompt).toContain("schema_");
  });

  it("rejects a repair prompt that exceeds the fixed context budget", async () => {
    const runtime = await fauxRuntime();
    runtime.faux.setResponses([
      structuredResponse({
        classification: "relevant",
        rubricItems: fullAwards,
        recommendedFollowUp: null,
        oversized: "x".repeat(runtime.model.contextWindow),
      }),
      structuredResponse({
        classification: "relevant",
        rubricItems: fullAwards,
        recommendedFollowUp: null,
      }),
    ]);
    const adapter = new PiAnswerEvaluationModel(runtime);

    await expect(adapter.evaluate(request)).rejects.toMatchObject({
      code: "invalid_output",
      issues: [
        expect.objectContaining({
          code: "repair_context_too_large",
        }),
      ],
    });
    expect(runtime.faux.getPendingResponseCount()).toBe(1);
  });

  it("fails after one repair and does not retry schema or domain rejection", async () => {
    const runtime = await fauxRuntime();
    const invalidOutput = {
      classification: "relevant",
      rubricItems: fullAwards,
      recommendedFollowUp: null,
      metadata: {
        provider: "model-invented",
      },
    };
    runtime.faux.setResponses([
      structuredResponse(invalidOutput),
      structuredResponse(invalidOutput),
      structuredResponse({
        classification: "relevant",
        rubricItems: fullAwards,
        recommendedFollowUp: null,
      }),
    ]);
    const adapter = new PiAnswerEvaluationModel(runtime);

    await expect(adapter.evaluate(request)).rejects.toMatchObject({
      name: "AnswerEvaluationModelError",
      code: "invalid_output",
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: expect.stringMatching(/^schema_/u),
        }),
      ]),
    });
    expect(runtime.faux.getPendingResponseCount()).toBe(1);
  });

  it("retries classified transient provider failures twice with bounded exponential backoff", async () => {
    const runtime = await fauxRuntime();
    const delays: number[] = [];
    let calls = 0;
    const transient: FauxResponseFactory = () => {
      calls += 1;
      return fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "503 service unavailable; please retry your request",
      });
    };
    runtime.faux.setResponses([transient, transient, transient]);
    const adapter = new PiAnswerEvaluationModel(runtime, {
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    await expect(adapter.evaluate(request)).rejects.toMatchObject({
      code: "transient_provider_failure",
      metadata: {
        provider: "faux",
        modelId: "answer-evaluation-test-model",
        purpose: "answer_evaluation",
        inputTokens: expect.any(Number),
      },
    });
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  it("does not retry permanent provider errors", async () => {
    const runtime = await fauxRuntime();
    const delays: number[] = [];
    let calls = 0;
    const permanent: FauxResponseFactory = () => {
      calls += 1;
      return fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "401 invalid API key",
      });
    };
    runtime.faux.setResponses([
      permanent,
      structuredResponse({
        classification: "relevant",
        rubricItems: fullAwards,
        recommendedFollowUp: null,
      }),
    ]);
    const adapter = new PiAnswerEvaluationModel(runtime, {
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });
    const freshRequest = createFixtureEvaluationRequest(correctFixture);
    const originalRequest = structuredClone(freshRequest);

    await expect(adapter.evaluate(freshRequest)).rejects.toMatchObject({
      code: "provider_failure",
      metadata: {
        provider: "faux",
        modelId: "answer-evaluation-test-model",
        purpose: "answer_evaluation",
        inputTokens: expect.any(Number),
      },
    });
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
    expect(runtime.faux.getPendingResponseCount()).toBe(1);
    expect(freshRequest).toEqual(originalRequest);
  });

  it.each([
    {
      name: "duplicate and missing Rubric IDs",
      output: {
        classification: "relevant",
        rubricItems: [
          fullAwards[0],
          {
            ...fullAwards[0],
            awardedPoints: 20,
            missingOrIncorrectPoints: ["重复的 Rubric 结果"],
          },
        ],
        recommendedFollowUp: null,
      },
      issueCode: "duplicate_rubric_id",
    },
    {
      name: "awarded points above item weight",
      output: {
        classification: "relevant",
        rubricItems: [
          {
            ...fullAwards[0],
            awardedPoints: 61,
          },
          fullAwards[1],
        ],
        recommendedFollowUp: null,
      },
      issueCode: "awarded_points_exceed_weight",
    },
    {
      name: "unknown evidence",
      output: {
        classification: "relevant",
        rubricItems: [
          {
            ...fullAwards[0],
            evidenceMaterialIds: ["answer-not-supplied"],
          },
          fullAwards[1],
        ],
        recommendedFollowUp: null,
      },
      issueCode: "unknown_evidence_id",
    },
    {
      name: "positive award without evidence",
      output: {
        classification: "relevant",
        rubricItems: [
          {
            ...fullAwards[0],
            evidenceMaterialIds: [],
          },
          fullAwards[1],
        ],
        recommendedFollowUp: null,
      },
      issueCode: "missing_evidence",
    },
    {
      name: "missing first irrelevant clarification",
      output: {
        classification: "irrelevant",
        rubricItems: zeroAwards,
        recommendedFollowUp: null,
      },
      issueCode: "irrelevant_clarification_required",
    },
    {
      name: "goal not supplied by the snapshot",
      output: {
        classification: "ambiguous",
        rubricItems: partialAwards,
        recommendedFollowUp: {
          goalId: "goal-invented",
          kind: "clarification",
          purpose: "answer_clarification",
        },
      },
      issueCode: "unknown_follow_up_goal",
    },
    {
      name: "purpose incompatible with goal kind",
      output: {
        classification: "relevant",
        rubricItems: partialAwards,
        recommendedFollowUp: {
          goalId: "goal-depth",
          kind: "depth",
          purpose: "answer_clarification",
        },
      },
      issueCode: "incompatible_follow_up_purpose",
    },
    {
      name: "irrelevant-only purpose on a relevant response",
      output: {
        classification: "relevant",
        rubricItems: partialAwards,
        recommendedFollowUp: {
          goalId: "goal-clarification",
          kind: "clarification",
          purpose: "irrelevant_response_clarification",
        },
      },
      issueCode: "classification_purpose_mismatch",
    },
    {
      name: "oversized missing or incorrect text",
      output: {
        classification: "relevant",
        rubricItems: [
          {
            ...partialAwards[0],
            missingOrIncorrectPoints: ["缺".repeat(MAX_MISSING_OR_INCORRECT_POINT_CHARACTERS + 1)],
          },
          partialAwards[1],
        ],
        recommendedFollowUp: null,
      },
      issueCode: "invalid_missing_point_length",
    },
  ])("rejects $name through evidence, goal, and text bounds", async ({ output, issueCode }) => {
    const runtime = await fauxRuntime();
    runtime.faux.setResponses([structuredResponse(output), structuredResponse(output)]);
    const adapter = new PiAnswerEvaluationModel(runtime);

    await expect(adapter.evaluate(request)).rejects.toMatchObject({
      code: "invalid_output",
      issues: expect.arrayContaining([expect.objectContaining({ code: issueCode })]),
    });
  });

  it("rejects exact goal reuse and exhausted follow-up kinds", async () => {
    const runtime = await fauxRuntime();
    const usedRequest: AnswerEvaluationRequest = {
      ...request,
      usedFollowUpGoalIds: new Set([parseFollowUpGoalId("goal-used")]),
    };
    const outputs = [
      {
        classification: "ambiguous",
        rubricItems: partialAwards,
        recommendedFollowUp: {
          goalId: "goal-used",
          kind: "clarification",
          purpose: "answer_clarification",
        },
      },
      {
        classification: "ambiguous",
        rubricItems: partialAwards,
        recommendedFollowUp: {
          goalId: "goal-clarification",
          kind: "clarification",
          purpose: "answer_clarification",
        },
      },
    ];
    runtime.faux.setResponses(
      outputs.flatMap((output) => [structuredResponse(output), structuredResponse(output)]),
    );
    const adapter = new PiAnswerEvaluationModel(runtime);

    await expect(adapter.evaluate(usedRequest)).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "used_follow_up_goal" }),
        expect.objectContaining({ code: "follow_up_kind_already_used" }),
      ]),
    });
    await expect(adapter.evaluate(usedRequest)).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "follow_up_kind_already_used" }),
      ]),
    });
  });

  it("rejects answer material that cannot fit the fixed model context", async () => {
    const runtime = await fauxRuntime();
    const tooMany = Array.from(
      { length: MAX_EVALUATION_ANSWER_MATERIAL_ITEMS + 1 },
      (_, index): AnswerMaterial => ({
        id: parseAnswerMaterialId(`oversized-item-${index}`),
        kind: "supplement",
        text: "补充",
        submittedAt: new Date("2026-08-11T10:00:00.000Z"),
      }),
    );
    const tooLarge = Array.from(
      { length: 5 },
      (_, index): AnswerMaterial => ({
        id: parseAnswerMaterialId(`oversized-text-${index}`),
        kind: index === 0 ? "main_answer" : "supplement",
        text: "答".repeat(20_000),
        submittedAt: new Date("2026-08-11T10:00:00.000Z"),
      }),
    );
    const adapter = new PiAnswerEvaluationModel(runtime);

    for (const material of [tooMany, tooLarge]) {
      await expect(
        adapter.evaluate({
          ...request,
          answerMaterial: material,
        }),
      ).rejects.toEqual(new AnswerEvaluationModelError("invalid_request"));
    }
    expect(runtime.faux.getPendingResponseCount()).toBe(0);
  });

  it("attaches only server-owned fixed runtime and version metadata after success", async () => {
    const runtime = await fauxRuntime("configured-evaluation-model");
    runtime.faux.setResponses([
      structuredResponse({
        classification: "relevant",
        rubricItems: fullAwards,
        recommendedFollowUp: null,
      }),
    ]);
    const adapter = new PiAnswerEvaluationModel(runtime);

    const result = await adapter.evaluate(request);

    expect(result.metadata).toEqual({
      provider: "faux",
      modelId: "configured-evaluation-model",
      promptVersion: CURRENT_MODEL_PROMPT_VERSIONS.answer_evaluation,
      schemaVersion: CURRENT_MODEL_SCHEMA_VERSIONS.answer_evaluation,
      questionVersion: 7,
      purpose: "answer_evaluation",
      latencyMs: expect.any(Number),
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
    });
    expect(result.metadata.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.metadata.inputTokens).toBeGreaterThan(0);
    expect(result.metadata.outputTokens).toBeGreaterThan(0);
  });
});
