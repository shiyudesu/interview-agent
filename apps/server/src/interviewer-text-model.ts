import { Agent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { isMeaningfulSimplifiedChineseText } from "@interview-agent/contracts";
import type {
  AnswerMaterial,
  FollowUpGoalSnapshot,
  FollowUpPurpose,
  InterviewerTextEvent,
  InterviewerTextModel,
  InterviewerTextRequest,
  ModelCallMetadata,
  QuestionSnapshot,
} from "@interview-agent/domain";
import { Check } from "typebox/value";

import { encodeUntrustedModelContent, getCurrentModelContract } from "./model-contract-registry.js";
import type { ModelRuntime } from "./model-runtime.js";
import {
  completeModelTelemetrySpan,
  failModelTelemetrySpan,
  modelTelemetryAttributes,
  withTelemetrySpan,
} from "./telemetry.js";

const TEMPLATE_PLACEHOLDER_PATTERN = /\{\{([a-z0-9_]+)\}\}/gu;
const PRIVATE_LABEL_PATTERN =
  /(?:Rubric|评分点|评分项|评分标准|参考答案|标准答案|完整答案|答案(?:是|为)|知识说明)/iu;
const FOLLOW_UP_MAX_CHARACTERS = 180;
export const MAX_INTERVIEWER_ANSWER_MATERIAL_ITEMS = 8;
export const MAX_INTERVIEWER_ANSWER_MATERIAL_CHARACTERS = 12_000;
const GENERIC_HAN_ANCHORS = new Set([
  "请说",
  "说明",
  "请解",
  "解释",
  "问题",
  "什么",
  "如何",
  "为何",
  "影响",
  "关系",
  "区别",
  "场景",
  "需要",
  "应当",
  "可以",
  "同时",
  "以及",
  "相关",
  "使用",
  "进行",
  "通过",
  "保持",
  "避免",
  "考虑",
]);

export type InterviewerTextModelErrorCode =
  | "invalid_request"
  | "model_call_failed"
  | "invalid_output";

export class InterviewerTextModelError extends Error {
  constructor(
    readonly code: InterviewerTextModelErrorCode,
    readonly metadata: ModelCallMetadata | null,
  ) {
    super(
      code === "invalid_request"
        ? "Interviewer text request is invalid"
        : code === "model_call_failed"
          ? "Interviewer text model call failed"
          : "Interviewer text model output is invalid",
    );
    this.name = "InterviewerTextModelError";
  }
}

interface LeakageCandidate {
  readonly text: string;
  readonly minimumNormalizedLength: number;
}

interface PreparedInterviewerTextCall {
  readonly purpose: InterviewerTextRequest["purpose"];
  readonly systemPrompt: string;
  readonly input: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly outputSchema: ReturnType<typeof getCurrentModelContract>["outputSchema"];
  readonly questionVersion: number;
  readonly sourceWording: string;
  readonly semanticReference: string;
  readonly allowedTechnicalText: string;
  readonly privateIdentifiers: readonly string[];
  readonly leakageCandidates: readonly LeakageCandidate[];
}

interface AgentAttempt {
  readonly deltas: readonly string[];
  readonly message: AssistantMessage | null;
  readonly usedToolCall: boolean;
}

export class PiAgentInterviewerTextModel implements InterviewerTextModel {
  constructor(private readonly runtime: ModelRuntime) {}

  stream(request: InterviewerTextRequest): AsyncIterable<InterviewerTextEvent> {
    const call = prepareCall(request);
    return this.execute(call);
  }

  private async *execute(call: PreparedInterviewerTextCall): AsyncIterable<InterviewerTextEvent> {
    const events = await withTelemetrySpan(
      "interview.model.call",
      modelTelemetryAttributes({
        provider: this.runtime.model.provider,
        modelId: this.runtime.model.id,
        purpose: call.purpose,
        promptVersion: call.promptVersion,
        schemaVersion: call.schemaVersion,
        questionVersion: call.questionVersion,
      }),
      async (span) => {
        const startedAt = performance.now();
        let attempt: AgentAttempt = {
          deltas: [],
          message: null,
          usedToolCall: false,
        };

        try {
          attempt = await runNoToolAgent(this.runtime, call);
          const output = validatedOutput(call, attempt);
          const metadata = createMetadata(this.runtime, call, startedAt, attempt.message);
          completeModelTelemetrySpan(span, metadata, { outcome: "success" });

          const deltas = attempt.deltas.length > 0 ? attempt.deltas : [output];
          return [
            ...deltas
              .filter((delta) => delta.length > 0)
              .map((delta) => ({ type: "delta" as const, text: delta })),
            { type: "completed" as const, text: output, metadata },
          ];
        } catch (error) {
          const metadata = createMetadata(this.runtime, call, startedAt, attempt.message);
          if (call.purpose === "rephrase_question") {
            completeModelTelemetrySpan(span, metadata, { outcome: "fallback" });
            return [
              { type: "delta" as const, text: call.sourceWording },
              { type: "completed" as const, text: call.sourceWording, metadata },
            ];
          }
          if (error instanceof InterviewerTextModelError) {
            failModelTelemetrySpan(span, error.code, metadata);
            throw new InterviewerTextModelError(error.code, metadata);
          }
          failModelTelemetrySpan(span, "model_call_failed", metadata);
          throw new InterviewerTextModelError("model_call_failed", metadata);
        }
      },
    );
    for (const event of events) {
      yield event;
    }
  }
}

function prepareCall(request: InterviewerTextRequest): PreparedInterviewerTextCall {
  const contract = getCurrentModelContract(request.purpose);
  if (contract.callKind !== "text_generation") {
    throw new InterviewerTextModelError("invalid_request", null);
  }

  const question = boundedQuestionFacts(request.question);
  const commonValues = {
    source_wording_json: trustedJson(question.sourceWording),
  };
  const rubricIdentifiers = request.question.rubric.map(({ id }) => id);
  const rubricLeakage = request.question.rubric.map(({ description }) => ({
    text: description,
    minimumNormalizedLength: 6,
  }));

  switch (request.purpose) {
    case "rephrase_question":
      return {
        purpose: request.purpose,
        systemPrompt: contract.prompt.system,
        input: renderTemplate(contract.prompt.inputTemplate, commonValues),
        promptVersion: contract.promptVersion,
        schemaVersion: contract.schemaVersion,
        outputSchema: contract.outputSchema,
        questionVersion: question.questionVersion,
        sourceWording: question.sourceWording,
        semanticReference: question.sourceWording,
        allowedTechnicalText: question.sourceWording,
        privateIdentifiers: rubricIdentifiers,
        leakageCandidates: rubricLeakage,
      };
    case "clarify_question":
      return {
        purpose: request.purpose,
        systemPrompt: contract.prompt.system,
        input: renderTemplate(contract.prompt.inputTemplate, {
          ...commonValues,
          displayed_wording_base64url: encodeUntrustedModelContent(
            request.question.displayedWording,
          ),
        }),
        promptVersion: contract.promptVersion,
        schemaVersion: contract.schemaVersion,
        outputSchema: contract.outputSchema,
        questionVersion: question.questionVersion,
        sourceWording: question.sourceWording,
        semanticReference: question.sourceWording,
        allowedTechnicalText: question.sourceWording,
        privateIdentifiers: rubricIdentifiers,
        leakageCandidates: rubricLeakage,
      };
    case "phrase_follow_up": {
      validateFollowUpRequest(question.followUpGoals, request);
      const answerMaterial = boundedAnswerMaterial(request.answerMaterial);
      return {
        purpose: request.purpose,
        systemPrompt: contract.prompt.system,
        input: renderTemplate(contract.prompt.inputTemplate, {
          ...commonValues,
          selected_follow_up_goal_json: trustedJson(request.goal),
          follow_up_purpose_json: trustedJson(request.followUpPurpose),
          answer_material_base64url: encodeUntrustedModelContent(answerMaterial),
        }),
        promptVersion: contract.promptVersion,
        schemaVersion: contract.schemaVersion,
        outputSchema: contract.outputSchema,
        questionVersion: question.questionVersion,
        sourceWording: question.sourceWording,
        semanticReference: request.goal.goal,
        allowedTechnicalText: `${question.sourceWording}\n${request.goal.goal}`,
        privateIdentifiers: [
          ...rubricIdentifiers,
          request.goal.id,
          ...answerMaterial.map(({ id }) => id),
        ],
        leakageCandidates: [
          ...rubricLeakage,
          ...answerMaterial.map(({ text }) => ({
            text,
            minimumNormalizedLength: 12,
          })),
        ],
      };
    }
  }
}

function boundedQuestionFacts(question: QuestionSnapshot): {
  readonly questionVersion: number;
  readonly sourceWording: string;
  readonly followUpGoals: readonly FollowUpGoalSnapshot[];
} {
  return {
    questionVersion: question.questionVersion,
    sourceWording: question.sourceWording,
    followUpGoals: question.followUpGoals.map(({ id, kind, goal }) => ({ id, kind, goal })),
  };
}

function boundedAnswerMaterial(answerMaterial: readonly AnswerMaterial[]): readonly {
  readonly id: string;
  readonly kind: AnswerMaterial["kind"];
  readonly text: string;
}[] {
  const totalCharacters = answerMaterial.reduce((total, item) => total + [...item.text].length, 0);
  if (
    answerMaterial.length === 0 ||
    answerMaterial.length > MAX_INTERVIEWER_ANSWER_MATERIAL_ITEMS ||
    totalCharacters > MAX_INTERVIEWER_ANSWER_MATERIAL_CHARACTERS ||
    answerMaterial.some(({ text }) => text.trim().length === 0)
  ) {
    throw new InterviewerTextModelError("invalid_request", null);
  }
  return answerMaterial.map(({ id, kind, text }) => ({ id, kind, text }));
}

function validateFollowUpRequest(
  followUpGoals: readonly FollowUpGoalSnapshot[],
  request: Extract<InterviewerTextRequest, { purpose: "phrase_follow_up" }>,
): void {
  const selectedGoal = followUpGoals.find(({ id }) => id === request.goal.id);
  if (
    selectedGoal === undefined ||
    selectedGoal.kind !== request.goal.kind ||
    selectedGoal.goal !== request.goal.goal ||
    !isPurposeCompatible(request.goal.kind, request.followUpPurpose)
  ) {
    throw new InterviewerTextModelError("invalid_request", null);
  }
}

function isPurposeCompatible(
  goalKind: FollowUpGoalSnapshot["kind"],
  purpose: FollowUpPurpose,
): boolean {
  return goalKind === "depth" ? purpose === "depth" : purpose !== "depth";
}

function trustedJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new InterviewerTextModelError("invalid_request", null);
  }
  return encoded;
}

function renderTemplate(template: string, values: Readonly<Record<string, string>>): string {
  const used = new Set<string>();
  const rendered = template.replace(TEMPLATE_PLACEHOLDER_PATTERN, (_placeholder, key: string) => {
    if (!Object.hasOwn(values, key)) {
      throw new InterviewerTextModelError("invalid_request", null);
    }
    used.add(key);
    return values[key] ?? "";
  });
  if (Object.keys(values).some((key) => !used.has(key))) {
    throw new InterviewerTextModelError("invalid_request", null);
  }
  return rendered;
}

async function runNoToolAgent(
  runtime: ModelRuntime,
  call: PreparedInterviewerTextCall,
): Promise<AgentAttempt> {
  const deltas: string[] = [];
  let message: AssistantMessage | null = null;
  let usedToolCall = false;
  const agent = new Agent({
    initialState: {
      systemPrompt: call.systemPrompt,
      model: runtime.model,
      thinkingLevel: "off",
      tools: [],
      messages: [],
    },
    streamFn: (_model, context: Context) => runtime.client.streamSimple(context),
    shouldStopAfterTurn: () => true,
  });

  agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      deltas.push(event.assistantMessageEvent.delta);
    } else if (event.type === "tool_execution_start") {
      usedToolCall = true;
    } else if (event.type === "turn_end" && event.message.role === "assistant") {
      message = event.message;
    }
  });

  await agent.prompt(call.input);
  return {
    deltas: Object.freeze(deltas),
    message,
    usedToolCall,
  };
}

function validatedOutput(call: PreparedInterviewerTextCall, attempt: AgentAttempt): string {
  const message = attempt.message;
  if (
    message === null ||
    message.stopReason !== "stop" ||
    attempt.usedToolCall ||
    message.content.some(({ type }) => type === "toolCall")
  ) {
    throw new InterviewerTextModelError("model_call_failed", null);
  }

  const output = message.content
    .filter((content) => content.type === "text")
    .map(({ text }) => text)
    .join("");
  if (
    !Check(call.outputSchema, output) ||
    output.trim().length === 0 ||
    !isMeaningfulSimplifiedChineseText(output) ||
    PRIVATE_LABEL_PATTERN.test(output) ||
    exposesPrivateContent(output, call)
  ) {
    throw new InterviewerTextModelError("invalid_output", null);
  }
  if (call.purpose === "phrase_follow_up" && !isOneConciseFollowUp(output)) {
    throw new InterviewerTextModelError("invalid_output", null);
  }
  validatePurposeAlignment(call, output);
  return output;
}

function exposesPrivateContent(output: string, call: PreparedInterviewerTextCall): boolean {
  const foldedOutput = output.toLocaleLowerCase("en-US");
  if (
    call.privateIdentifiers.some(
      (identifier) =>
        identifier.length >= 6 && foldedOutput.includes(identifier.toLocaleLowerCase("en-US")),
    )
  ) {
    return true;
  }

  const normalizedOutput = normalizeForLeakageCheck(output);
  return call.leakageCandidates.some(({ text, minimumNormalizedLength }) => {
    const normalizedCandidate = normalizeForLeakageCheck(text);
    return (
      normalizedCandidate.length >= minimumNormalizedLength &&
      normalizedOutput.includes(normalizedCandidate)
    );
  });
}

function validatePurposeAlignment(call: PreparedInterviewerTextCall, output: string): void {
  const allowedTechnicalTerms = technicalTerms(call.allowedTechnicalText);
  const outputTechnicalTerms = technicalTerms(output);
  if ([...outputTechnicalTerms].some((term) => !allowedTechnicalTerms.has(term))) {
    throw new InterviewerTextModelError("invalid_output", null);
  }

  if (call.purpose === "rephrase_question") {
    const normalizedOutput = output.toLocaleLowerCase("en-US");
    const missingTechnicalTerm = primaryTechnicalTerms(call.sourceWording).some(
      (term) => !normalizedOutput.includes(term),
    );
    if (missingTechnicalTerm || semanticAnchorCoverage(output, call.sourceWording) < 0.8) {
      throw new InterviewerTextModelError("invalid_output", null);
    }
    return;
  }
  if (call.purpose === "clarify_question") {
    const sourceTechnicalTerms = technicalTerms(call.sourceWording);
    if (
      sourceTechnicalTerms.size > 0 &&
      ![...sourceTechnicalTerms].some((term) => outputTechnicalTerms.has(term))
    ) {
      throw new InterviewerTextModelError("invalid_output", null);
    }
    if (!hasSemanticAnchorOverlap(output, call.sourceWording, 2)) {
      throw new InterviewerTextModelError("invalid_output", null);
    }
    return;
  }
  if (call.purpose === "phrase_follow_up") {
    if (!hasSemanticAnchorOverlap(output, call.semanticReference, 2)) {
      throw new InterviewerTextModelError("invalid_output", null);
    }
    return;
  }
}

function primaryTechnicalTerms(text: string): readonly string[] {
  return [...text.matchAll(/[A-Za-z][A-Za-z0-9._/-]*/gu)].map(({ 0: term }) =>
    term.toLocaleLowerCase("en-US"),
  );
}

function technicalTerms(text: string): ReadonlySet<string> {
  const terms = new Set<string>();
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9._/-]*/gu)) {
    const term = match[0].toLocaleLowerCase("en-US");
    terms.add(term);
    for (const segment of term.split(/[._/-]/u)) {
      if (segment.length >= 2) {
        terms.add(segment);
      }
    }
  }
  return terms;
}

function hasSemanticAnchorOverlap(output: string, reference: string, required: number): boolean {
  const referenceAnchors = hanAnchors(reference);
  if (referenceAnchors.size === 0) {
    return true;
  }

  const outputAnchors = hanAnchors(output);
  let overlap = 0;
  for (const anchor of referenceAnchors) {
    if (outputAnchors.has(anchor)) {
      overlap += 1;
    }
  }
  return overlap >= Math.min(required, referenceAnchors.size);
}

function semanticAnchorCoverage(output: string, reference: string): number {
  const referenceAnchors = hanAnchors(reference);
  if (referenceAnchors.size === 0) {
    return 1;
  }
  const outputAnchors = hanAnchors(output);
  let overlap = 0;
  for (const anchor of referenceAnchors) {
    if (outputAnchors.has(anchor)) {
      overlap += 1;
    }
  }
  return overlap / referenceAnchors.size;
}

function hanAnchors(text: string): ReadonlySet<string> {
  const anchors = new Set<string>();
  for (const sequence of text.match(/\p{Script=Han}{2,}/gu) ?? []) {
    for (let index = 0; index < sequence.length - 1; index += 1) {
      const anchor = sequence.slice(index, index + 2);
      if (!GENERIC_HAN_ANCHORS.has(anchor)) {
        anchors.add(anchor);
      }
    }
  }
  return anchors;
}

function normalizeForLeakageCheck(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function isOneConciseFollowUp(output: string): boolean {
  const trimmed = output.trim();
  const questionMarkCount = trimmed.match(/[?？]/gu)?.length ?? 0;
  return (
    [...trimmed].length <= FOLLOW_UP_MAX_CHARACTERS &&
    !/[\r\n]/u.test(trimmed) &&
    questionMarkCount === 1 &&
    /[?？]$/u.test(trimmed) &&
    !/[。！!；;]/u.test(trimmed.slice(0, -1))
  );
}

function createMetadata(
  runtime: ModelRuntime,
  call: PreparedInterviewerTextCall,
  startedAt: number,
  message: AssistantMessage | null,
): ModelCallMetadata {
  return {
    provider: runtime.model.provider,
    modelId: runtime.model.id,
    promptVersion: call.promptVersion,
    schemaVersion: call.schemaVersion,
    questionVersion: call.questionVersion,
    purpose: call.purpose,
    latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    inputTokens: validTokenCount(message?.usage.input),
    outputTokens: validTokenCount(message?.usage.output),
  };
}

function validTokenCount(value: number | undefined): number | null {
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : null;
}
