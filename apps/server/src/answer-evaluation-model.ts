import {
  type AssistantMessage,
  type Context,
  isRetryableAssistantError,
  type Tool,
} from "@earendil-works/pi-ai";
import type { ModelAnswerEvaluationOutputDto } from "@interview-agent/contracts";
import {
  type AnswerEvaluationModel,
  type AnswerEvaluationRequest,
  type AnswerEvaluationResult,
  type FollowUpPurpose,
  InvalidRubricAwardError,
  type ModelCallMetadata,
  parseAnswerMaterialId,
  parseEvaluationId,
  parseFollowUpGoalId,
  parseRubricItemId,
  scoreQuestion,
  validateRubric,
} from "@interview-agent/domain";
import type { TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

import { encodeUntrustedModelContent, getCurrentModelContract } from "./model-contract-registry.js";
import type { ModelRuntime } from "./model-runtime.js";

const TEMPLATE_PLACEHOLDER_PATTERN = /\{\{([a-z0-9_]+)\}\}/gu;
const ANSWER_EVALUATION_OUTPUT_TOOL_NAME = "submit_answer_evaluation";
const MAX_TRANSIENT_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 100;
const MAX_VALIDATION_ISSUES = 16;
const MAX_VALIDATION_ISSUE_PATH_CHARACTERS = 160;
const MAX_VALIDATION_ISSUE_MESSAGE_CHARACTERS = 240;
export const MAX_MISSING_OR_INCORRECT_POINTS_PER_ITEM = 6;
export const MAX_MISSING_OR_INCORRECT_POINT_CHARACTERS = 300;
export const MAX_MISSING_OR_INCORRECT_TOTAL_CHARACTERS = 1_200;
export const MAX_EVALUATION_ANSWER_MATERIAL_ITEMS = 32;
export const EVALUATION_INPUT_CONTEXT_FRACTION = 0.45;

export type AnswerEvaluationModelErrorCode =
  | "invalid_request"
  | "provider_failure"
  | "transient_provider_failure"
  | "invalid_output";

export interface AnswerEvaluationValidationIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export class AnswerEvaluationModelError extends Error {
  constructor(
    readonly code: AnswerEvaluationModelErrorCode,
    readonly issues: readonly AnswerEvaluationValidationIssue[] = [],
    readonly metadata: ModelCallMetadata | null = null,
  ) {
    super(
      code === "invalid_request"
        ? "Answer evaluation request is invalid"
        : code === "invalid_output"
          ? "Answer evaluation model output is invalid"
          : code === "transient_provider_failure"
            ? "Answer evaluation model transient retries were exhausted"
            : "Answer evaluation model call failed",
    );
    this.name = "AnswerEvaluationModelError";
  }
}

export interface AnswerEvaluationModelOptions {
  readonly sleep?: (delayMs: number) => Promise<void>;
}

interface PreparedAnswerEvaluationCall {
  readonly systemPrompt: string;
  readonly initialInput: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly questionVersion: number;
  readonly outputSchema: TSchema;
  readonly outputTool: Tool;
  readonly request: AnswerEvaluationRequest;
  readonly modelContextWindow: number;
  readonly answerMaterialCount: number;
}

interface ExecutionState {
  transientRetries: number;
  readonly messages: AssistantMessage[];
}

interface ParsedAttempt {
  readonly value: ModelAnswerEvaluationOutputDto | null;
  readonly issues: readonly AnswerEvaluationValidationIssue[];
  readonly visibleOutput: unknown;
}

const VALIDATION_EVALUATION_ID = parseEvaluationId("answer-evaluation-adapter-validation");

export class PiAnswerEvaluationModel implements AnswerEvaluationModel {
  readonly #sleep: (delayMs: number) => Promise<void>;

  constructor(
    private readonly runtime: ModelRuntime,
    options: AnswerEvaluationModelOptions = {},
  ) {
    this.#sleep = options.sleep ?? sleep;
  }

  async evaluate(request: AnswerEvaluationRequest): Promise<AnswerEvaluationResult> {
    const call = prepareCall(request, this.runtime.model.contextWindow);
    const startedAt = performance.now();
    const state: ExecutionState = {
      transientRetries: 0,
      messages: [],
    };

    try {
      const initialMessage = await this.callProvider(
        call,
        call.initialInput,
        state,
        "invalid_request",
      );
      let parsed = parseAttempt(call, initialMessage);

      if (parsed.value === null) {
        const repairInput = createRepairInput(
          call.initialInput,
          parsed.issues,
          parsed.visibleOutput,
        );
        const repairMessage = await this.callProvider(call, repairInput, state, "invalid_output");
        parsed = parseAttempt(call, repairMessage);
        if (parsed.value === null) {
          throw new AnswerEvaluationModelError("invalid_output", parsed.issues);
        }
      }

      return createResult(this.runtime, call, parsed.value, startedAt, state.messages);
    } catch (error) {
      if (error instanceof AnswerEvaluationModelError) {
        throw new AnswerEvaluationModelError(
          error.code,
          error.issues,
          createMetadata(this.runtime, call, startedAt, state.messages),
        );
      }
      throw error;
    }
  }

  private async callProvider(
    call: PreparedAnswerEvaluationCall,
    input: string,
    state: ExecutionState,
    budgetErrorCode: "invalid_output" | "invalid_request",
  ): Promise<AssistantMessage> {
    validateContextBudget(call, input, budgetErrorCode);
    for (;;) {
      let message: AssistantMessage;
      try {
        message = await this.runtime.client.completeStructured(createContext(call, input));
      } catch {
        throw new AnswerEvaluationModelError("provider_failure");
      }
      state.messages.push(message);

      if (message.stopReason !== "error" && message.stopReason !== "aborted") {
        return message;
      }
      if (
        message.stopReason !== "error" ||
        !isRetryableAssistantError(message) ||
        state.transientRetries >= MAX_TRANSIENT_RETRIES
      ) {
        throw new AnswerEvaluationModelError(
          message.stopReason === "error" && isRetryableAssistantError(message)
            ? "transient_provider_failure"
            : "provider_failure",
        );
      }

      const delayMs = RETRY_BASE_DELAY_MS * 2 ** state.transientRetries;
      state.transientRetries += 1;
      await this.#sleep(delayMs);
    }
  }
}

function prepareCall(
  request: AnswerEvaluationRequest,
  modelContextWindow: number,
): PreparedAnswerEvaluationCall {
  const contract = getCurrentModelContract("answer_evaluation");
  if (contract.callKind !== "decision_bearing_structured") {
    throw new AnswerEvaluationModelError("invalid_request");
  }

  validateRequest(request);
  const question = Object.freeze({
    questionId: request.question.questionId,
    questionVersion: request.question.questionVersion,
    domain: request.question.domain,
    sourceWording: request.question.sourceWording,
    rubric: Object.freeze(
      request.question.rubric.map(({ id, description, weight }) =>
        Object.freeze({ id, description, weight }),
      ),
    ),
    followUpGoals: Object.freeze(
      request.question.followUpGoals.map(({ id, kind, goal }) => Object.freeze({ id, kind, goal })),
    ),
  });
  const answerMaterial = Object.freeze(
    request.answerMaterial.map(({ id, kind, text }) => Object.freeze({ id, kind, text })),
  );
  const usedFollowUpGoalIds = Object.freeze(
    question.followUpGoals
      .filter(({ id }) => request.usedFollowUpGoalIds.has(id))
      .map(({ id }) => id),
  );
  const capturedRequest: AnswerEvaluationRequest = Object.freeze({
    question: Object.freeze({
      ...request.question,
      rubric: question.rubric,
      followUpGoals: question.followUpGoals,
    }),
    answerMaterial: Object.freeze(
      request.answerMaterial.map((item) =>
        Object.freeze({
          ...item,
          submittedAt: new Date(item.submittedAt),
        }),
      ),
    ),
    usedFollowUpGoalIds: new Set(usedFollowUpGoalIds),
  });
  const outputToolSource = {
    name: ANSWER_EVALUATION_OUTPUT_TOOL_NAME,
    description:
      "Submit exactly one final answer-evaluation value. Do not emit prose or call any other tool.",
    parameters: contract.outputSchema,
    constrainedSampling: {
      type: "json_schema",
      strict: "prefer",
    },
  } as const satisfies Tool;
  const outputTool: Tool = Object.freeze(outputToolSource);

  const initialInput = renderTemplate(contract.prompt.inputTemplate, {
    question_id_json: trustedJson(question.questionId),
    question_version_json: trustedJson(question.questionVersion),
    question_domain_json: trustedJson(question.domain),
    source_wording_json: trustedJson(question.sourceWording),
    rubric_json: trustedJson(question.rubric),
    predefined_follow_up_goals_json: trustedJson(question.followUpGoals),
    used_follow_up_goal_ids_json: trustedJson(usedFollowUpGoalIds),
    output_schema_json: trustedJson(contract.outputSchema),
    answer_material_base64url: encodeUntrustedModelContent(answerMaterial),
  });
  const prepared = Object.freeze({
    systemPrompt: contract.prompt.system,
    initialInput,
    promptVersion: contract.promptVersion,
    schemaVersion: contract.schemaVersion,
    questionVersion: question.questionVersion,
    outputSchema: contract.outputSchema,
    outputTool,
    request: capturedRequest,
    modelContextWindow,
    answerMaterialCount: request.answerMaterial.length,
  });
  validateContextBudget(prepared, initialInput, "invalid_request");
  return prepared;
}

function validateContextBudget(
  call: Pick<
    PreparedAnswerEvaluationCall,
    "answerMaterialCount" | "modelContextWindow" | "outputSchema" | "systemPrompt"
  >,
  input: string,
  errorCode: "invalid_output" | "invalid_request",
): void {
  const schemaJson = JSON.stringify(call.outputSchema);
  const estimatedInputTokens = Math.ceil(
    (call.systemPrompt.length + input.length + schemaJson.length) / 2,
  );
  if (
    call.answerMaterialCount > MAX_EVALUATION_ANSWER_MATERIAL_ITEMS ||
    !Number.isInteger(call.modelContextWindow) ||
    call.modelContextWindow < 1 ||
    estimatedInputTokens > Math.floor(call.modelContextWindow * EVALUATION_INPUT_CONTEXT_FRACTION)
  ) {
    throw new AnswerEvaluationModelError(
      errorCode,
      errorCode === "invalid_output"
        ? [
            issue(
              "/",
              "repair_context_too_large",
              "The invalid output cannot be repaired within the fixed model context budget",
            ),
          ]
        : [],
    );
  }
}

function validateRequest(request: AnswerEvaluationRequest): void {
  try {
    validateRubric(request.question.rubric);
  } catch {
    throw new AnswerEvaluationModelError("invalid_request");
  }
  if (
    !Number.isInteger(request.question.questionVersion) ||
    request.question.questionVersion < 1 ||
    request.question.sourceWording.trim().length === 0 ||
    request.answerMaterial.length === 0
  ) {
    throw new AnswerEvaluationModelError("invalid_request");
  }

  const materialIds = new Set<string>();
  for (const material of request.answerMaterial) {
    if (
      materialIds.has(material.id) ||
      material.text.trim().length === 0 ||
      !Number.isFinite(material.submittedAt.getTime())
    ) {
      throw new AnswerEvaluationModelError("invalid_request");
    }
    materialIds.add(material.id);
  }

  const goalIds = new Set<string>();
  for (const goal of request.question.followUpGoals) {
    if (goalIds.has(goal.id) || goal.goal.trim().length === 0) {
      throw new AnswerEvaluationModelError("invalid_request");
    }
    goalIds.add(goal.id);
  }
  if ([...request.usedFollowUpGoalIds].some((goalId) => !goalIds.has(goalId))) {
    throw new AnswerEvaluationModelError("invalid_request");
  }
}

function createContext(call: PreparedAnswerEvaluationCall, input: string): Context {
  return {
    systemPrompt: call.systemPrompt,
    messages: [
      {
        role: "user",
        content: input,
        timestamp: Date.now(),
      },
    ],
    tools: [call.outputTool],
  };
}

function parseAttempt(
  call: PreparedAnswerEvaluationCall,
  message: AssistantMessage,
): ParsedAttempt {
  const visibleOutput = visibleModelOutput(message);
  const toolCalls = message.content.filter((content) => content.type === "toolCall");
  const visibleText = message.content
    .filter((content) => content.type === "text")
    .map(({ text }) => text)
    .join("");
  const structureIssues: AnswerEvaluationValidationIssue[] = [];

  if (message.stopReason !== "stop" && message.stopReason !== "toolUse") {
    structureIssues.push(
      issue("/", "invalid_stop_reason", "Output must finish with one structured result"),
    );
  }
  if (visibleText.trim().length > 0) {
    structureIssues.push(
      issue("/", "unexpected_text", "Output must not contain prose outside the structured result"),
    );
  }
  if (toolCalls.length !== 1) {
    structureIssues.push(
      issue("/", "tool_call_count", "Output must contain exactly one answer-evaluation tool call"),
    );
  }

  const toolCall = toolCalls[0];
  if (toolCall !== undefined && toolCall.name !== ANSWER_EVALUATION_OUTPUT_TOOL_NAME) {
    structureIssues.push(
      issue("/tool", "wrong_tool", `Output tool must be ${ANSWER_EVALUATION_OUTPUT_TOOL_NAME}`),
    );
  }
  if (toolCall === undefined) {
    return {
      value: null,
      issues: sanitizeIssues(structureIssues),
      visibleOutput,
    };
  }

  const candidate: unknown = toolCall.arguments;
  if (!Check(call.outputSchema, candidate)) {
    return {
      value: null,
      issues: sanitizeIssues([
        ...structureIssues,
        ...[...Errors(call.outputSchema, candidate)].map((error) =>
          issue(error.instancePath || "/", `schema_${error.keyword}`, error.message),
        ),
      ]),
      visibleOutput,
    };
  }

  const checkedCandidate = candidate as ModelAnswerEvaluationOutputDto;
  const issues = [...structureIssues, ...validateDomainOutput(call.request, checkedCandidate)];
  return issues.length === 0
    ? { value: checkedCandidate, issues: [], visibleOutput }
    : { value: null, issues: sanitizeIssues(issues), visibleOutput };
}

function validateDomainOutput(
  request: AnswerEvaluationRequest,
  output: ModelAnswerEvaluationOutputDto,
): readonly AnswerEvaluationValidationIssue[] {
  const issues: AnswerEvaluationValidationIssue[] = [];
  const rubricById = new Map(request.question.rubric.map((item) => [item.id, item] as const));
  const seenRubricIds = new Set<string>();
  const validEvidenceIds = new Set(request.answerMaterial.map(({ id }) => id));
  let totalMissingOrIncorrectCharacters = 0;
  let awardedPoints = 0;

  if (output.rubricItems.length !== request.question.rubric.length) {
    issues.push(
      issue(
        "/rubricItems",
        "rubric_item_count",
        `Every supplied Rubric ID must appear exactly once; expected ${request.question.rubric.length} items`,
      ),
    );
  }

  for (const [index, award] of output.rubricItems.entries()) {
    const path = `/rubricItems/${index}`;
    const rubricItem = rubricById.get(parseRubricItemId(award.rubricItemId));
    awardedPoints += award.awardedPoints;
    if (seenRubricIds.has(award.rubricItemId)) {
      issues.push(
        issue(`${path}/rubricItemId`, "duplicate_rubric_id", "Rubric ID must appear exactly once"),
      );
    } else {
      seenRubricIds.add(award.rubricItemId);
    }
    if (rubricItem === undefined) {
      issues.push(
        issue(
          `${path}/rubricItemId`,
          "unknown_rubric_id",
          "Rubric ID must be one of the supplied server-owned IDs",
        ),
      );
    }

    if (rubricItem !== undefined && award.awardedPoints > rubricItem.weight) {
      issues.push(
        issue(
          `${path}/awardedPoints`,
          "awarded_points_exceed_weight",
          `Awarded points must be between 0 and ${rubricItem.weight}`,
        ),
      );
    }
    if (award.awardedPoints > 0 && award.evidenceMaterialIds.length === 0) {
      issues.push(
        issue(
          `${path}/evidenceMaterialIds`,
          "missing_evidence",
          "Positive awarded points require supplied answer-material evidence",
        ),
      );
    }
    for (const [evidenceIndex, evidenceId] of award.evidenceMaterialIds.entries()) {
      if (!validEvidenceIds.has(parseAnswerMaterialId(evidenceId))) {
        issues.push(
          issue(
            `${path}/evidenceMaterialIds/${evidenceIndex}`,
            "unknown_evidence_id",
            "Evidence ID must reference supplied accepted answer material",
          ),
        );
      }
    }

    if (award.missingOrIncorrectPoints.length > MAX_MISSING_OR_INCORRECT_POINTS_PER_ITEM) {
      issues.push(
        issue(
          `${path}/missingOrIncorrectPoints`,
          "too_many_missing_points",
          `At most ${MAX_MISSING_OR_INCORRECT_POINTS_PER_ITEM} missing or incorrect points are allowed per Rubric item`,
        ),
      );
    }
    if (
      rubricItem !== undefined &&
      award.awardedPoints < rubricItem.weight &&
      award.missingOrIncorrectPoints.length === 0
    ) {
      issues.push(
        issue(
          `${path}/missingOrIncorrectPoints`,
          "missing_points_required",
          "An under-awarded Rubric item requires at least one concise missing or incorrect point",
        ),
      );
    }
    if (
      rubricItem !== undefined &&
      award.awardedPoints === rubricItem.weight &&
      award.missingOrIncorrectPoints.length > 0
    ) {
      issues.push(
        issue(
          `${path}/missingOrIncorrectPoints`,
          "unexpected_missing_points",
          "A fully awarded Rubric item must not report missing or incorrect points",
        ),
      );
    }
    for (const [pointIndex, point] of award.missingOrIncorrectPoints.entries()) {
      const characterCount = [...point].length;
      totalMissingOrIncorrectCharacters += characterCount;
      if (point.trim().length === 0 || characterCount > MAX_MISSING_OR_INCORRECT_POINT_CHARACTERS) {
        issues.push(
          issue(
            `${path}/missingOrIncorrectPoints/${pointIndex}`,
            "invalid_missing_point_length",
            `Missing or incorrect text must contain 1-${MAX_MISSING_OR_INCORRECT_POINT_CHARACTERS} characters`,
          ),
        );
      }
    }
  }

  for (const rubricId of rubricById.keys()) {
    if (!seenRubricIds.has(rubricId)) {
      issues.push(
        issue("/rubricItems", "missing_rubric_id", `Missing required Rubric ID ${rubricId}`),
      );
    }
  }
  if (totalMissingOrIncorrectCharacters > MAX_MISSING_OR_INCORRECT_TOTAL_CHARACTERS) {
    issues.push(
      issue(
        "/rubricItems",
        "missing_points_total_too_long",
        `Missing or incorrect text must total at most ${MAX_MISSING_OR_INCORRECT_TOTAL_CHARACTERS} characters`,
      ),
    );
  }
  if (output.classification === "irrelevant" && awardedPoints !== 0) {
    issues.push(
      issue(
        "/rubricItems",
        "irrelevant_awarded_points",
        "An irrelevant response cannot receive awarded points",
      ),
    );
  }

  validateRecommendation(request, output, issues);

  if (issues.length === 0) {
    try {
      scoreQuestion({
        rubric: request.question.rubric,
        evaluation: {
          id: VALIDATION_EVALUATION_ID,
          classification: output.classification,
          rubricItems: output.rubricItems.map((award) => ({
            rubricItemId: parseRubricItemId(award.rubricItemId),
            evidenceMaterialIds: award.evidenceMaterialIds.map(parseAnswerMaterialId),
            awardedPoints: award.awardedPoints,
            missingOrIncorrectPoints: award.missingOrIncorrectPoints,
          })),
        },
        validEvidenceMaterialIds: new Set(request.answerMaterial.map(({ id }) => id)),
      });
    } catch (error) {
      issues.push(
        error instanceof InvalidRubricAwardError
          ? issue("/", error.code, error.message)
          : issue("/", "domain_rejection", "Output violates deterministic scoring rules"),
      );
    }
  }

  return issues;
}

function validateRecommendation(
  request: AnswerEvaluationRequest,
  output: ModelAnswerEvaluationOutputDto,
  issues: AnswerEvaluationValidationIssue[],
): void {
  const recommendation = output.recommendedFollowUp;
  const usedKinds = new Set(
    request.question.followUpGoals
      .filter(({ id }) => request.usedFollowUpGoalIds.has(id))
      .map(({ kind }) => kind),
  );
  if (recommendation === null) {
    if (output.classification === "irrelevant" && !usedKinds.has("clarification")) {
      issues.push(
        issue(
          "/recommendedFollowUp",
          "irrelevant_clarification_required",
          "A first irrelevant response requires an unused clarification follow-up",
        ),
      );
    }
    return;
  }
  const goalId = parseFollowUpGoalId(recommendation.goalId);
  if (request.usedFollowUpGoalIds.has(goalId)) {
    issues.push(
      issue(
        "/recommendedFollowUp/goalId",
        "used_follow_up_goal",
        "Recommended goal must not have been used already",
      ),
    );
  }
  if (usedKinds.has(recommendation.kind)) {
    issues.push(
      issue(
        "/recommendedFollowUp/kind",
        "follow_up_kind_already_used",
        `A ${recommendation.kind} follow-up has already been used`,
      ),
    );
  }
  if (!isPurposeCompatible(recommendation.kind, recommendation.purpose)) {
    issues.push(
      issue(
        "/recommendedFollowUp/purpose",
        "incompatible_follow_up_purpose",
        "Recommended purpose must be compatible with the predefined goal kind",
      ),
    );
  }
  const suppliedGoal = request.question.followUpGoals.find(({ id }) => id === goalId);
  if (suppliedGoal === undefined) {
    issues.push(
      issue(
        "/recommendedFollowUp/goalId",
        "unknown_follow_up_goal",
        "Recommended goal must be one of the supplied predefined goals",
      ),
    );
  } else if (recommendation.kind !== suppliedGoal.kind) {
    issues.push(
      issue(
        "/recommendedFollowUp/kind",
        "follow_up_kind_mismatch",
        "Recommended kind must match the supplied predefined goal",
      ),
    );
  }
  if (
    output.classification === "irrelevant"
      ? recommendation.purpose !== "irrelevant_response_clarification"
      : recommendation.purpose === "irrelevant_response_clarification"
  ) {
    issues.push(
      issue(
        "/recommendedFollowUp/purpose",
        "classification_purpose_mismatch",
        output.classification === "irrelevant"
          ? "Irrelevant responses may recommend only an irrelevant-response clarification"
          : "Only irrelevant responses may recommend an irrelevant-response clarification",
      ),
    );
  }
}

function isPurposeCompatible(kind: "clarification" | "depth", purpose: FollowUpPurpose): boolean {
  return kind === "depth" ? purpose === "depth" : purpose !== "depth";
}

function createRepairInput(
  initialInput: string,
  issues: readonly AnswerEvaluationValidationIssue[],
  invalidOutput: unknown,
): string {
  return `${initialInput}
<TRUSTED_STRUCTURE_REPAIR>
validationIssues=${trustedJson(sanitizeIssues(issues))}
Repair only the listed structural or domain violations. Preserve all trusted question, Rubric, evidence, and follow-up identifiers. Submit exactly one corrected value through the supplied output tool.
</TRUSTED_STRUCTURE_REPAIR>
<UNTRUSTED_MODEL_CONTENT encoding="base64url-json">
${encodeUntrustedModelContent(invalidOutput)}
</UNTRUSTED_MODEL_CONTENT>`;
}

function visibleModelOutput(message: AssistantMessage): unknown {
  const content: unknown[] = [];
  for (const block of message.content) {
    if (block.type === "thinking") {
      continue;
    }
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
      continue;
    }
    content.push({
      type: "toolCall",
      name: block.name,
      arguments: block.arguments,
    });
  }
  return {
    stopReason: message.stopReason,
    content,
  };
}

function createResult(
  runtime: ModelRuntime,
  call: PreparedAnswerEvaluationCall,
  output: ModelAnswerEvaluationOutputDto,
  startedAt: number,
  messages: readonly AssistantMessage[],
): AnswerEvaluationResult {
  const metadata = createMetadata(runtime, call, startedAt, messages);
  return Object.freeze({
    classification: output.classification,
    rubricItems: Object.freeze(
      output.rubricItems.map((award) =>
        Object.freeze({
          rubricItemId: parseRubricItemId(award.rubricItemId),
          evidenceMaterialIds: Object.freeze(award.evidenceMaterialIds.map(parseAnswerMaterialId)),
          awardedPoints: award.awardedPoints,
          missingOrIncorrectPoints: Object.freeze([...award.missingOrIncorrectPoints]),
        }),
      ),
    ),
    recommendedFollowUpGoal:
      output.recommendedFollowUp === null
        ? null
        : Object.freeze({
            goalId: parseFollowUpGoalId(output.recommendedFollowUp.goalId),
            kind: output.recommendedFollowUp.kind,
            purpose: output.recommendedFollowUp.purpose,
          }),
    metadata,
  });
}

function createMetadata(
  runtime: ModelRuntime,
  call: PreparedAnswerEvaluationCall,
  startedAt: number,
  messages: readonly AssistantMessage[],
): ModelCallMetadata {
  return Object.freeze({
    provider: runtime.model.provider,
    modelId: runtime.model.id,
    promptVersion: call.promptVersion,
    schemaVersion: call.schemaVersion,
    questionVersion: call.questionVersion,
    purpose: "answer_evaluation",
    latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    inputTokens: totalTokenCount(messages, "input"),
    outputTokens: totalTokenCount(messages, "output"),
  });
}

function totalTokenCount(
  messages: readonly AssistantMessage[],
  direction: "input" | "output",
): number | null {
  let total = 0;
  let found = false;
  for (const message of messages) {
    const value = message.usage[direction];
    if (Number.isInteger(value) && value >= 0) {
      total += value;
      found = true;
    }
  }
  return found ? total : null;
}

function issue(path: string, code: string, message: string): AnswerEvaluationValidationIssue {
  return { path, code, message };
}

function sanitizeIssues(
  issues: readonly AnswerEvaluationValidationIssue[],
): readonly AnswerEvaluationValidationIssue[] {
  return Object.freeze(
    issues.slice(0, MAX_VALIDATION_ISSUES).map((candidate) =>
      Object.freeze({
        path: sanitizeText(candidate.path, MAX_VALIDATION_ISSUE_PATH_CHARACTERS) || "/",
        code: sanitizeText(candidate.code, 80) || "invalid_output",
        message:
          sanitizeText(candidate.message, MAX_VALIDATION_ISSUE_MESSAGE_CHARACTERS) ||
          "Output is invalid",
      }),
    ),
  );
}

function sanitizeText(value: string, maximumCharacters: number): string {
  const withoutControls = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? " " : character;
    })
    .join("");
  return [...withoutControls.replace(/\s+/gu, " ").trim()].slice(0, maximumCharacters).join("");
}

function trustedJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new AnswerEvaluationModelError("invalid_request");
  }
  return encoded;
}

function renderTemplate(template: string, values: Readonly<Record<string, string>>): string {
  const used = new Set<string>();
  const rendered = template.replace(TEMPLATE_PLACEHOLDER_PATTERN, (_placeholder, key: string) => {
    if (!Object.hasOwn(values, key)) {
      throw new AnswerEvaluationModelError("invalid_request");
    }
    used.add(key);
    return values[key] ?? "";
  });
  if (Object.keys(values).some((key) => !used.has(key))) {
    throw new AnswerEvaluationModelError("invalid_request");
  }
  return rendered;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
