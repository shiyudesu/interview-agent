import {
  type AssistantMessage,
  type Context,
  isRetryableAssistantError,
  type Tool,
} from "@earendil-works/pi-ai";
import {
  isMeaningfulSimplifiedChineseText,
  type ModelReportAnalysisOutputDto,
} from "@interview-agent/contracts";
import {
  ANSWER_MATERIAL_KINDS,
  aggregateCompleteInterviewScore,
  aggregateDomainScores,
  createZeroQuestionOutcome,
  isSupportedQuestionCount,
  KNOWLEDGE_DOMAINS,
  type KnowledgeDomain,
  type ModelCallMetadata,
  parseAnswerMaterialId,
  parseEvaluationId,
  parseFollowUpGoalId,
  parsePositiveQuestionScore,
  parseQuestionId,
  parseRubricItemId,
  type QuestionOutcome,
  type ReportAnalysisModel,
  type ReportAnalysisRequest,
  type ReportAnalysisResult,
  type ResponseClassification,
  type RubricItemEvaluation,
  type RubricItemSnapshot,
  scoreQuestion,
  validateRubric,
} from "@interview-agent/domain";
import type { TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

import { encodeUntrustedModelContent, getCurrentModelContract } from "./model-contract-registry.js";
import type { ModelRuntime } from "./model-runtime.js";
import {
  createQuestionPrivateContentScope,
  exposesFragmentedPrivateContent,
  exposesPrivateContent,
  type PrivateContentCandidate,
} from "./private-assessment-content.js";

const TEMPLATE_PLACEHOLDER_PATTERN = /\{\{([a-z0-9_]+)\}\}/gu;
const REPORT_ANALYSIS_OUTPUT_TOOL_NAME = "submit_report_analysis";
const MAX_TRANSIENT_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 100;
const MAX_VALIDATION_ISSUES = 20;
const MAX_VALIDATION_ISSUE_PATH_CHARACTERS = 160;
const MAX_VALIDATION_ISSUE_MESSAGE_CHARACTERS = 240;
const MAX_REPORT_QUESTIONS = 15;
const MAX_REPORT_RUBRIC_ITEMS_PER_QUESTION = 16;
const MAX_REPORT_FOLLOW_UP_GOALS_PER_QUESTION = 16;
const MAX_REPORT_MISSING_POINTS_PER_RUBRIC_ITEM = 6;
const MAX_REPORT_MISSING_POINT_CHARACTERS = 300;
const MAX_REPORT_MODEL_AUTHORED_INPUT_CHARACTERS = 18_000;
const MAX_REPORT_OVERALL_EXPLANATION_CHARACTERS = 2_000;
const MAX_REPORT_QUESTION_TEXT_CHARACTERS = 1_000;
const MAX_REPORT_LIST_ITEMS = 8;
const MAX_REPORT_QUESTION_SUGGESTIONS = 6;
const MAX_REPORT_LIST_ITEM_CHARACTERS = 300;
const MAX_REPORT_OUTPUT_CHARACTERS = 16_000;
const CANONICAL_CLAIM_PATTERN =
  /(?:完整报告|不完整报告|总分|得分|分数|评分|满分|零分|百分之|[0-9０-９一二三四五六七八九十百]+分|%|complete report|incomplete report|overall score|total score|score\s*[:=]?\s*\d+|\d+\s*(?:points?|percent))/iu;
const ZERO_OUTCOME_POSITIVE_PATTERN =
  /(?:完全正确|全部正确|回答正确|答对|部分正确|掌握良好|表现优秀|获得满分)/u;
const SCORED_OUTCOME_NEGATIVE_PATTERN =
  /(?:未作答|没有作答|跳过|不知道|完全错误|毫不相关|没有可分析的作答)/u;
const FULL_CORRECTNESS_PATTERN =
  /(?:完全正确|全部正确|回答完全正确|答对全部|所有题.{0,8}回答正确|每道题.{0,8}回答正确|满分)/u;
const UNKNOWN_REASON_PATTERN = /(?:不知道|不会|不清楚|未掌握)/u;
const SKIPPED_REASON_PATTERN = /(?:跳过|略过|未回答但选择跳过)/u;
const IRRELEVANT_REASON_PATTERN = /(?:不相关|答非所问|偏题|毫不相关)/u;
const INCORRECT_REASON_PATTERN = /(?:完全错误|全部错误|回答错误|概念错误)/u;

export const MAX_REPORT_ANSWER_MATERIAL_ITEMS_PER_QUESTION = 32;
export const MAX_REPORT_ANSWER_MATERIAL_ITEMS = 128;
export const MAX_REPORT_ANSWER_EVIDENCE_CHARACTERS = 32_000;
export const REPORT_INPUT_CONTEXT_FRACTION = 0.45;

export type ReportAnalysisModelErrorCode =
  | "invalid_request"
  | "provider_failure"
  | "transient_provider_failure"
  | "invalid_output";

export interface ReportAnalysisValidationIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export class ReportAnalysisModelError extends Error {
  constructor(
    readonly code: ReportAnalysisModelErrorCode,
    readonly issues: readonly ReportAnalysisValidationIssue[] = [],
    readonly metadata: ModelCallMetadata | null = null,
  ) {
    super(
      code === "invalid_request"
        ? "Report analysis request is invalid"
        : code === "invalid_output"
          ? "Report analysis model output is invalid"
          : code === "transient_provider_failure"
            ? "Report analysis model transient retries were exhausted"
            : "Report analysis model call failed",
    );
    this.name = "ReportAnalysisModelError";
  }
}

export interface ReportAnalysisModelOptions {
  readonly sleep?: (delayMs: number) => Promise<void>;
}

interface PreparedReportQuestion {
  readonly questionId: ReturnType<typeof parseQuestionId>;
  readonly acceptedEvidenceIds: readonly ReturnType<typeof parseAnswerMaterialId>[];
  readonly requiredEvidenceIds: readonly ReturnType<typeof parseAnswerMaterialId>[];
  readonly requiresAnswerEvidence: boolean;
  readonly outcome: QuestionOutcome;
}

interface PreparedReportAnalysisCall {
  readonly systemPrompt: string;
  readonly initialInput: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly outputSchema: TSchema;
  readonly outputTool: Tool;
  readonly modelContextWindow: number;
  readonly answerMaterialCount: number;
  readonly answerEvidenceCharacters: number;
  readonly outputTokenBudget: number;
  readonly outputCharacterBudget: number;
  readonly reportKind: "complete" | "incomplete";
  readonly questions: readonly PreparedReportQuestion[];
  readonly privateIdentifiers: readonly string[];
  readonly leakageCandidates: readonly PrivateContentCandidate[];
}

interface PreparedRequestFacts {
  readonly reportKind: "complete" | "incomplete";
  readonly deterministicScores: Readonly<Record<string, unknown>>;
  readonly serverOwnedEvaluationFacts: readonly Readonly<Record<string, unknown>>[];
  readonly questionVersions: readonly Readonly<Record<string, unknown>>[];
  readonly modelAuthoredEvaluationText: Readonly<Record<string, unknown>>;
  readonly boundedAnswerEvidence: Readonly<Record<string, unknown>>;
  readonly answerMaterialCount: number;
  readonly answerEvidenceCharacters: number;
  readonly questions: readonly PreparedReportQuestion[];
  readonly privateIdentifiers: readonly string[];
  readonly leakageCandidates: readonly PrivateContentCandidate[];
}

interface NormalizedQuestionSnapshot {
  readonly questionId: ReturnType<typeof parseQuestionId>;
  readonly questionVersion: number;
  readonly domain: KnowledgeDomain;
  readonly sourceWording: string;
  readonly displayedWording: string;
  readonly rubric: readonly RubricItemSnapshot[];
  readonly followUpGoals: readonly {
    readonly id: ReturnType<typeof parseFollowUpGoalId>;
    readonly kind: "clarification" | "depth";
    readonly goal: string;
  }[];
  readonly knowledgeExplanation: string;
}

interface NormalizedAnswerMaterial {
  readonly id: ReturnType<typeof parseAnswerMaterialId>;
  readonly kind: (typeof ANSWER_MATERIAL_KINDS)[number];
  readonly text: string;
}

interface NormalizedEvaluation {
  readonly classification: ResponseClassification;
  readonly rubricItems: readonly RubricItemEvaluation[];
  readonly outcome: QuestionOutcome;
}

interface NormalizedReportQuestion {
  readonly question: NormalizedQuestionSnapshot;
  readonly answerMaterial: readonly NormalizedAnswerMaterial[];
  readonly evaluation: NormalizedEvaluation | null;
  readonly outcome: QuestionOutcome;
}

interface ExecutionState {
  transientRetries: number;
  readonly messages: AssistantMessage[];
}

interface ParsedAttempt {
  readonly value: ModelReportAnalysisOutputDto | null;
  readonly issues: readonly ReportAnalysisValidationIssue[];
  readonly visibleOutput: unknown;
}

export class PiReportAnalysisModel implements ReportAnalysisModel {
  readonly #sleep: (delayMs: number) => Promise<void>;

  constructor(
    private readonly runtime: ModelRuntime,
    options: ReportAnalysisModelOptions = {},
  ) {
    this.#sleep = options.sleep ?? sleep;
  }

  async analyze(request: ReportAnalysisRequest): Promise<ReportAnalysisResult> {
    const call = prepareCall(
      request,
      this.runtime.model.contextWindow,
      this.runtime.model.maxTokens,
    );
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
          throw new ReportAnalysisModelError("invalid_output", parsed.issues);
        }
      }

      return createResult(this.runtime, call, parsed.value, startedAt, state.messages);
    } catch (error) {
      if (error instanceof ReportAnalysisModelError) {
        throw new ReportAnalysisModelError(
          error.code,
          error.issues,
          createMetadata(this.runtime, call, startedAt, state.messages),
        );
      }
      throw error;
    }
  }

  private async callProvider(
    call: PreparedReportAnalysisCall,
    input: string,
    state: ExecutionState,
    budgetErrorCode: "invalid_output" | "invalid_request",
  ): Promise<AssistantMessage> {
    validateContextBudget(call, input, budgetErrorCode);
    for (;;) {
      let message: AssistantMessage;
      try {
        message = await this.runtime.client.completeStructured(createContext(call, input), {
          maxTokens: call.outputTokenBudget,
        });
      } catch {
        throw new ReportAnalysisModelError("provider_failure");
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
        throw new ReportAnalysisModelError(
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
  request: ReportAnalysisRequest,
  modelContextWindow: number,
  modelMaxTokens: number,
): PreparedReportAnalysisCall {
  const contract = getCurrentModelContract("report_analysis");
  if (contract.callKind !== "decision_bearing_structured") {
    throw new ReportAnalysisModelError("invalid_request");
  }

  let facts: PreparedRequestFacts;
  try {
    facts = prepareRequestFacts(request);
  } catch {
    throw new ReportAnalysisModelError("invalid_request");
  }

  const outputToolSource = {
    name: REPORT_ANALYSIS_OUTPUT_TOOL_NAME,
    description:
      "Submit exactly one final report-analysis value. Do not emit prose or call any other tool.",
    parameters: contract.outputSchema,
    constrainedSampling: {
      type: "json_schema",
      strict: "prefer",
    },
  } as const satisfies Tool;
  const outputTool: Tool = Object.freeze(outputToolSource);
  const initialInput = renderTemplate(contract.prompt.inputTemplate, {
    report_kind_json: trustedJson(facts.reportKind),
    deterministic_scores_json: trustedJson(facts.deterministicScores),
    server_owned_evaluation_facts_json: trustedJson(facts.serverOwnedEvaluationFacts),
    question_versions_json: trustedJson(facts.questionVersions),
    output_schema_json: trustedJson(contract.outputSchema),
    model_authored_evaluation_text_base64url: encodeUntrustedModelContent(
      facts.modelAuthoredEvaluationText,
    ),
    bounded_answer_evidence_base64url: encodeUntrustedModelContent(facts.boundedAnswerEvidence),
  });
  const schemaJson = JSON.stringify(contract.outputSchema);
  const estimatedInitialTokens = estimateContextTokens(
    contract.prompt.system,
    initialInput,
    schemaJson,
  );
  const framingReserve = 512;
  const availableOutputTokens = modelContextWindow - estimatedInitialTokens - framingReserve;
  if (!Number.isInteger(modelMaxTokens) || modelMaxTokens < 1 || availableOutputTokens < 1) {
    throw new ReportAnalysisModelError("invalid_request");
  }
  const outputTokenBudget = Math.min(
    modelMaxTokens,
    availableOutputTokens,
    MAX_REPORT_OUTPUT_CHARACTERS + 1_024,
  );
  const outputCharacterBudget = Math.max(
    1,
    Math.min(MAX_REPORT_OUTPUT_CHARACTERS, outputTokenBudget - 1_024),
  );
  const prepared = Object.freeze({
    systemPrompt: contract.prompt.system,
    initialInput,
    promptVersion: contract.promptVersion,
    schemaVersion: contract.schemaVersion,
    outputSchema: contract.outputSchema,
    outputTool,
    modelContextWindow,
    answerMaterialCount: facts.answerMaterialCount,
    answerEvidenceCharacters: facts.answerEvidenceCharacters,
    outputTokenBudget,
    outputCharacterBudget,
    reportKind: facts.reportKind,
    questions: facts.questions,
    privateIdentifiers: facts.privateIdentifiers,
    leakageCandidates: facts.leakageCandidates,
  });
  validateContextBudget(prepared, initialInput, "invalid_request");
  return prepared;
}

function prepareRequestFacts(request: unknown): PreparedRequestFacts {
  const input = record(request, "report analysis request");
  exactKeys(input, ["reportKind", "questions", "assessedDomains"]);
  const reportKind = literal(
    input["reportKind"],
    ["complete", "incomplete"] as const,
    "reportKind",
  );
  const questionInputs = array(input["questions"], "questions");
  if (
    (reportKind === "complete" && !isSupportedQuestionCount(questionInputs.length)) ||
    (reportKind === "incomplete" &&
      (questionInputs.length < 1 || questionInputs.length > MAX_REPORT_QUESTIONS))
  ) {
    throw new TypeError("Report question count is invalid for its kind");
  }

  const globalQuestionIds = new Set<string>();
  const globalEvidenceIds = new Set<string>();
  let answerMaterialCount = 0;
  let answerEvidenceCharacters = 0;
  let modelAuthoredInputCharacters = 0;
  const questions = questionInputs.map((value, index) => {
    const normalized = normalizeReportQuestion(value, `questions[${index}]`);
    if (globalQuestionIds.has(normalized.question.questionId)) {
      throw new TypeError("Question IDs must be unique");
    }
    globalQuestionIds.add(normalized.question.questionId);
    for (const material of normalized.answerMaterial) {
      if (globalEvidenceIds.has(material.id)) {
        throw new TypeError("Answer-material IDs must be globally unique");
      }
      globalEvidenceIds.add(material.id);
    }
    answerMaterialCount += normalized.answerMaterial.length;
    answerEvidenceCharacters += normalized.answerMaterial.reduce(
      (total, material) => total + characterCount(material.text),
      0,
    );
    modelAuthoredInputCharacters +=
      characterCount(normalized.question.sourceWording) +
      characterCount(normalized.question.displayedWording) +
      (normalized.evaluation?.rubricItems.reduce(
        (total, rubricItem) =>
          total +
          rubricItem.missingOrIncorrectPoints.reduce(
            (pointTotal, point) => pointTotal + characterCount(point),
            0,
          ),
        0,
      ) ?? 0);
    return normalized;
  });

  if (
    answerMaterialCount > MAX_REPORT_ANSWER_MATERIAL_ITEMS ||
    answerEvidenceCharacters > MAX_REPORT_ANSWER_EVIDENCE_CHARACTERS ||
    modelAuthoredInputCharacters > MAX_REPORT_MODEL_AUTHORED_INPUT_CHARACTERS
  ) {
    throw new TypeError("Report evidence exceeds fixed bounds");
  }

  const selectedScores = questions.map(({ question, outcome }) => ({
    domain: question.domain,
    outcome,
  }));
  const domains = aggregateDomainScores(selectedScores);
  const expectedAssessedDomains = domains.flatMap((result) =>
    result.status === "assessed" ? [result.domain] : [],
  );
  const assessedDomains = array(input["assessedDomains"], "assessedDomains").map((value, index) =>
    literal(value, KNOWLEDGE_DOMAINS, `assessedDomains[${index}]`),
  );
  const assessedDomainSet = new Set(assessedDomains);
  if (
    assessedDomainSet.size !== assessedDomains.length ||
    assessedDomains.length !== expectedAssessedDomains.length ||
    expectedAssessedDomains.some((domain) => !assessedDomainSet.has(domain))
  ) {
    throw new TypeError("Assessed domains must exactly match deterministic question coverage");
  }

  let deterministicScores: Readonly<Record<string, unknown>>;
  if (reportKind === "complete") {
    if (!isSupportedQuestionCount(questions.length)) {
      throw new TypeError("Complete report question count is invalid");
    }
    const assessedDomainCount = domains.filter((result) => result.status === "assessed").length;
    const expectedAssessedDomainCount = questions.length === 5 ? 5 : 6;
    if (assessedDomainCount !== expectedAssessedDomainCount) {
      throw new TypeError("Complete report domain coverage is invalid");
    }
    const completeScore = aggregateCompleteInterviewScore(selectedScores, questions.length);
    deterministicScores = Object.freeze({
      overallScore: completeScore.overallScore,
      domains: completeScore.domains,
    });
  } else {
    deterministicScores = Object.freeze({ domains });
  }

  const serverOwnedEvaluationFacts = Object.freeze(
    questions.map(({ question, answerMaterial, evaluation, outcome }, index) =>
      Object.freeze({
        position: index + 1,
        questionId: question.questionId,
        domain: question.domain,
        outcome: serializeOutcome(outcome),
        classification: evaluation?.classification ?? null,
        rubricItems:
          evaluation === null
            ? []
            : question.rubric.map((rubricItem) => {
                const award = requiredAward(evaluation.rubricItems, rubricItem.id);
                return Object.freeze({
                  rubricItemId: rubricItem.id,
                  weight: rubricItem.weight,
                  awardedPoints: award.awardedPoints,
                  evidenceMaterialIds: award.evidenceMaterialIds,
                });
              }),
        acceptedEvidence: answerMaterial.map(({ id, kind }) => Object.freeze({ id, kind })),
      }),
    ),
  );
  const questionVersions = Object.freeze(
    questions.map(({ question }, index) =>
      Object.freeze({
        position: index + 1,
        questionId: question.questionId,
        questionVersion: question.questionVersion,
      }),
    ),
  );
  const modelAuthoredEvaluationText = Object.freeze({
    questions: Object.freeze(
      questions.map(({ question, evaluation }) =>
        Object.freeze({
          sourceWording: question.sourceWording,
          displayedWording: question.displayedWording,
          missingOrIncorrectPoints:
            evaluation === null
              ? []
              : question.rubric.map((rubricItem) => {
                  const award = requiredAward(evaluation.rubricItems, rubricItem.id);
                  return Object.freeze({
                    rubricItemId: rubricItem.id,
                    points: Object.freeze([...award.missingOrIncorrectPoints]),
                  });
                }),
        }),
      ),
    ),
  });
  const boundedAnswerEvidence = Object.freeze({
    questions: Object.freeze(
      questions.map(({ answerMaterial }) =>
        Object.freeze({
          answerText: Object.freeze(answerMaterial.map(({ text }) => text)),
        }),
      ),
    ),
  });
  const preparedQuestions = Object.freeze(
    questions.map(({ question, answerMaterial, evaluation, outcome }) =>
      Object.freeze({
        questionId: question.questionId,
        acceptedEvidenceIds: Object.freeze(answerMaterial.map(({ id }) => id)),
        requiredEvidenceIds: Object.freeze(
          evaluation === null
            ? []
            : [
                ...new Set(
                  evaluation.rubricItems.flatMap(({ evidenceMaterialIds }) =>
                    evidenceMaterialIds.map(String),
                  ),
                ),
              ].map(parseAnswerMaterialId),
        ),
        requiresAnswerEvidence: evaluation !== null,
        outcome,
      }),
    ),
  );
  const privateScopes = questions.map(({ question }) =>
    createQuestionPrivateContentScope(question),
  );
  const privateIdentifiers = Object.freeze(
    privateScopes.flatMap(({ privateIdentifiers: identifiers }) => identifiers),
  );
  const leakageCandidates = Object.freeze(
    privateScopes.flatMap(({ leakageCandidates: candidates }) => candidates),
  );

  return Object.freeze({
    reportKind,
    deterministicScores,
    serverOwnedEvaluationFacts,
    questionVersions,
    modelAuthoredEvaluationText,
    boundedAnswerEvidence,
    answerMaterialCount,
    answerEvidenceCharacters,
    questions: preparedQuestions,
    privateIdentifiers,
    leakageCandidates,
  });
}

function normalizeReportQuestion(value: unknown, path: string): NormalizedReportQuestion {
  const input = record(value, path);
  if (input["evaluation"] === null) {
    exactKeys(input, ["question", "answerMaterial", "evaluation", "outcome"]);
  } else {
    exactKeys(input, ["question", "answerMaterial", "evaluation"]);
  }
  const question = normalizeQuestionSnapshot(input["question"], `${path}.question`);
  const answerMaterial = array(input["answerMaterial"], `${path}.answerMaterial`).map(
    (material, index) => normalizeAnswerMaterial(material, `${path}.answerMaterial[${index}]`),
  );
  if (answerMaterial.length > MAX_REPORT_ANSWER_MATERIAL_ITEMS_PER_QUESTION) {
    throw new TypeError("Too many answer-material items for one report question");
  }

  if (input["evaluation"] === null) {
    if (answerMaterial.length !== 0) {
      throw new TypeError("Unknown or skipped outcomes cannot include accepted answer material");
    }
    const outcome = normalizeOutcome(input["outcome"], `${path}.outcome`);
    if (outcome.kind !== "unknown" && outcome.kind !== "skipped") {
      throw new TypeError("Unevaluated report questions must be unknown or skipped");
    }
    return Object.freeze({
      question,
      answerMaterial: Object.freeze(answerMaterial),
      evaluation: null,
      outcome,
    });
  }

  if (answerMaterial.length === 0) {
    throw new TypeError("Evaluated report questions require accepted answer material");
  }
  const evaluation = normalizeEvaluation(
    input["evaluation"],
    question,
    answerMaterial,
    `${path}.evaluation`,
  );
  return Object.freeze({
    question,
    answerMaterial: Object.freeze(answerMaterial),
    evaluation,
    outcome: evaluation.outcome,
  });
}

function normalizeQuestionSnapshot(value: unknown, path: string): NormalizedQuestionSnapshot {
  const input = record(value, path);
  exactKeys(input, [
    "questionId",
    "questionVersion",
    "domain",
    "sourceWording",
    "displayedWording",
    "rubric",
    "followUpGoals",
    "knowledgeExplanation",
  ]);
  const rubric = array(input["rubric"], `${path}.rubric`).map((value, index) => {
    const item = record(value, `${path}.rubric[${index}]`);
    exactKeys(item, ["id", "description", "weight"]);
    return Object.freeze({
      id: parseRubricItemId(nonEmptyString(item["id"], `${path}.rubric[${index}].id`)),
      description: nonEmptyString(item["description"], `${path}.rubric[${index}].description`),
      weight: integer(item["weight"], `${path}.rubric[${index}].weight`, 1, 100),
    });
  });
  if (rubric.length > MAX_REPORT_RUBRIC_ITEMS_PER_QUESTION) {
    throw new TypeError("Question Rubric exceeds the report-analysis bound");
  }
  validateRubric(rubric);

  const goalIds = new Set<string>();
  const followUpGoals = array(input["followUpGoals"], `${path}.followUpGoals`).map(
    (value, index) => {
      const goal = record(value, `${path}.followUpGoals[${index}]`);
      exactKeys(goal, ["id", "kind", "goal"]);
      const id = parseFollowUpGoalId(
        nonEmptyString(goal["id"], `${path}.followUpGoals[${index}].id`),
      );
      if (goalIds.has(id)) {
        throw new TypeError("Follow-up goal IDs must be unique");
      }
      goalIds.add(id);
      return Object.freeze({
        id,
        kind: literal(
          goal["kind"],
          ["clarification", "depth"] as const,
          `${path}.followUpGoals[${index}].kind`,
        ),
        goal: nonEmptyString(goal["goal"], `${path}.followUpGoals[${index}].goal`),
      });
    },
  );
  if (
    followUpGoals.length === 0 ||
    followUpGoals.length > MAX_REPORT_FOLLOW_UP_GOALS_PER_QUESTION
  ) {
    throw new TypeError("Question follow-up goals exceed the report-analysis bound");
  }

  return Object.freeze({
    questionId: parseQuestionId(nonEmptyString(input["questionId"], `${path}.questionId`)),
    questionVersion: integer(input["questionVersion"], `${path}.questionVersion`, 1),
    domain: literal(input["domain"], KNOWLEDGE_DOMAINS, `${path}.domain`),
    sourceWording: nonEmptyString(input["sourceWording"], `${path}.sourceWording`),
    displayedWording: nonEmptyString(input["displayedWording"], `${path}.displayedWording`),
    rubric: Object.freeze(rubric),
    followUpGoals: Object.freeze(followUpGoals),
    knowledgeExplanation: nonEmptyString(
      input["knowledgeExplanation"],
      `${path}.knowledgeExplanation`,
    ),
  });
}

function normalizeAnswerMaterial(value: unknown, path: string): NormalizedAnswerMaterial {
  const input = record(value, path);
  exactKeys(input, ["id", "kind", "text", "submittedAt"]);
  const submittedAt = input["submittedAt"];
  if (!(submittedAt instanceof Date) || !Number.isFinite(submittedAt.getTime())) {
    throw new TypeError(`${path}.submittedAt must be a valid Date`);
  }
  return Object.freeze({
    id: parseAnswerMaterialId(nonEmptyString(input["id"], `${path}.id`)),
    kind: literal(input["kind"], ANSWER_MATERIAL_KINDS, `${path}.kind`),
    text: nonEmptyString(input["text"], `${path}.text`),
  });
}

function normalizeEvaluation(
  value: unknown,
  question: NormalizedQuestionSnapshot,
  answerMaterial: readonly NormalizedAnswerMaterial[],
  path: string,
): NormalizedEvaluation {
  const input = record(value, path);
  exactKeys(input, ["id", "classification", "rubricItems", "outcome"]);
  const rubricItems = array(input["rubricItems"], `${path}.rubricItems`).map((value, index) => {
    const award = record(value, `${path}.rubricItems[${index}]`);
    exactKeys(award, [
      "rubricItemId",
      "evidenceMaterialIds",
      "awardedPoints",
      "missingOrIncorrectPoints",
    ]);
    const evidenceMaterialIds = array(
      award["evidenceMaterialIds"],
      `${path}.rubricItems[${index}].evidenceMaterialIds`,
    ).map((id, evidenceIndex) =>
      parseAnswerMaterialId(
        nonEmptyString(id, `${path}.rubricItems[${index}].evidenceMaterialIds[${evidenceIndex}]`),
      ),
    );
    if (new Set(evidenceMaterialIds).size !== evidenceMaterialIds.length) {
      throw new TypeError("Rubric evidence IDs must be unique");
    }
    const missingOrIncorrectPoints = array(
      award["missingOrIncorrectPoints"],
      `${path}.rubricItems[${index}].missingOrIncorrectPoints`,
    ).map((point, pointIndex) => {
      const text = nonEmptyString(
        point,
        `${path}.rubricItems[${index}].missingOrIncorrectPoints[${pointIndex}]`,
      );
      if (characterCount(text) > MAX_REPORT_MISSING_POINT_CHARACTERS) {
        throw new TypeError("Evaluation text exceeds the report-analysis bound");
      }
      return text;
    });
    if (missingOrIncorrectPoints.length > MAX_REPORT_MISSING_POINTS_PER_RUBRIC_ITEM) {
      throw new TypeError("Evaluation point list exceeds the report-analysis bound");
    }
    return Object.freeze({
      rubricItemId: parseRubricItemId(
        nonEmptyString(award["rubricItemId"], `${path}.rubricItems[${index}].rubricItemId`),
      ),
      evidenceMaterialIds: Object.freeze(evidenceMaterialIds),
      awardedPoints: integer(
        award["awardedPoints"],
        `${path}.rubricItems[${index}].awardedPoints`,
        0,
        100,
      ),
      missingOrIncorrectPoints: Object.freeze(missingOrIncorrectPoints),
    });
  });
  const classification = literal(
    input["classification"],
    ["relevant", "ambiguous", "irrelevant"] as const,
    `${path}.classification`,
  );
  const scored = scoreQuestion({
    rubric: question.rubric,
    evaluation: {
      id: parseEvaluationId(nonEmptyString(input["id"], `${path}.id`)),
      classification,
      rubricItems,
    },
    validEvidenceMaterialIds: new Set(answerMaterial.map(({ id }) => id)),
  });
  const suppliedOutcome = normalizeOutcome(input["outcome"], `${path}.outcome`);
  if (!sameOutcome(scored.outcome, suppliedOutcome)) {
    throw new TypeError("Persisted evaluation outcome is inconsistent with deterministic scoring");
  }
  return Object.freeze({
    classification,
    rubricItems: Object.freeze(rubricItems),
    outcome: scored.outcome,
  });
}

function normalizeOutcome(value: unknown, path: string): QuestionOutcome {
  const input = record(value, path);
  const kind = literal(
    input["kind"],
    ["scored", "incorrect", "unknown", "skipped", "irrelevant"] as const,
    `${path}.kind`,
  );
  if (kind === "scored") {
    exactKeys(input, ["kind", "score"]);
    return Object.freeze({
      kind,
      score: parsePositiveQuestionScore(integer(input["score"], `${path}.score`, 1, 100)),
    });
  }
  exactKeys(input, ["kind", "score", "zeroScoreReason"]);
  if (
    input["score"] !== 0 ||
    literal(
      input["zeroScoreReason"],
      ["incorrect", "unknown", "skipped", "irrelevant"] as const,
      `${path}.zeroScoreReason`,
    ) !== kind
  ) {
    throw new TypeError(`${path} zero-score fields must match`);
  }
  return createZeroQuestionOutcome(kind);
}

function sameOutcome(left: QuestionOutcome, right: QuestionOutcome): boolean {
  return (
    left.kind === right.kind &&
    left.score === right.score &&
    ("zeroScoreReason" in left
      ? "zeroScoreReason" in right && left.zeroScoreReason === right.zeroScoreReason
      : !("zeroScoreReason" in right))
  );
}

function serializeOutcome(outcome: QuestionOutcome): Readonly<Record<string, unknown>> {
  return Object.freeze(
    outcome.kind === "scored"
      ? { kind: outcome.kind, score: outcome.score }
      : {
          kind: outcome.kind,
          score: outcome.score,
          zeroScoreReason: outcome.zeroScoreReason,
        },
  );
}

function requiredAward(
  rubricItems: readonly RubricItemEvaluation[],
  rubricItemId: ReturnType<typeof parseRubricItemId>,
): RubricItemEvaluation {
  const award = rubricItems.find((candidate) => candidate.rubricItemId === rubricItemId);
  if (award === undefined) {
    throw new TypeError("Evaluation is missing a Rubric item");
  }
  return award;
}

function validateContextBudget(
  call: Pick<
    PreparedReportAnalysisCall,
    | "answerEvidenceCharacters"
    | "answerMaterialCount"
    | "modelContextWindow"
    | "outputTokenBudget"
    | "outputCharacterBudget"
    | "outputSchema"
    | "systemPrompt"
  >,
  input: string,
  errorCode: "invalid_output" | "invalid_request",
): void {
  const schemaJson = JSON.stringify(call.outputSchema);
  const estimatedInputTokens = estimateContextTokens(call.systemPrompt, input, schemaJson);
  const toolAndFramingReserve = 512;
  if (
    call.answerMaterialCount > MAX_REPORT_ANSWER_MATERIAL_ITEMS ||
    call.answerEvidenceCharacters > MAX_REPORT_ANSWER_EVIDENCE_CHARACTERS ||
    !Number.isInteger(call.modelContextWindow) ||
    call.modelContextWindow < 1 ||
    !Number.isInteger(call.outputTokenBudget) ||
    call.outputTokenBudget < 1 ||
    estimatedInputTokens > Math.floor(call.modelContextWindow * REPORT_INPUT_CONTEXT_FRACTION) ||
    estimatedInputTokens + call.outputTokenBudget + toolAndFramingReserve > call.modelContextWindow
  ) {
    throw new ReportAnalysisModelError(
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

function estimateContextTokens(systemPrompt: string, input: string, schemaJson: string): number {
  return Buffer.byteLength(`${systemPrompt}\n${input}\n${schemaJson}`, "utf8");
}

function createContext(call: PreparedReportAnalysisCall, input: string): Context {
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

function parseAttempt(call: PreparedReportAnalysisCall, message: AssistantMessage): ParsedAttempt {
  const visibleOutput = visibleModelOutput(message);
  const toolCalls = message.content.filter((content) => content.type === "toolCall");
  const visibleText = message.content
    .filter((content) => content.type === "text")
    .map(({ text }) => text)
    .join("");
  const structureIssues: ReportAnalysisValidationIssue[] = [];

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
      issue("/", "tool_call_count", "Output must contain exactly one report-analysis tool call"),
    );
  }

  const toolCall = toolCalls[0];
  if (toolCall !== undefined && toolCall.name !== REPORT_ANALYSIS_OUTPUT_TOOL_NAME) {
    structureIssues.push(
      issue("/tool", "wrong_tool", `Output tool must be ${REPORT_ANALYSIS_OUTPUT_TOOL_NAME}`),
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

  const checkedCandidate = candidate as ModelReportAnalysisOutputDto;
  const issues = [...structureIssues, ...validateDomainOutput(call, checkedCandidate)];
  return issues.length === 0
    ? { value: checkedCandidate, issues: [], visibleOutput }
    : { value: null, issues: sanitizeIssues(issues), visibleOutput };
}

function validateDomainOutput(
  call: PreparedReportAnalysisCall,
  output: ModelReportAnalysisOutputDto,
): readonly ReportAnalysisValidationIssue[] {
  const issues: ReportAnalysisValidationIssue[] = [];
  let totalOutputCharacters = 0;
  const questionById = new Map(call.questions.map((question) => [question.questionId, question]));

  totalOutputCharacters += validateText(
    call,
    output.overallExplanation,
    "/overallExplanation",
    MAX_REPORT_OVERALL_EXPLANATION_CHARACTERS,
    issues,
  );
  for (const [field, values] of [
    ["strengths", output.strengths],
    ["weaknesses", output.weaknesses],
    ["priorities", output.priorities],
    ["learningSuggestions", output.learningSuggestions],
  ] as const) {
    if (values.length > MAX_REPORT_LIST_ITEMS) {
      issues.push(
        issue(`/${field}`, "too_many_items", `At most ${MAX_REPORT_LIST_ITEMS} items are allowed`),
      );
    }
    values.forEach((value, index) => {
      totalOutputCharacters += validateText(
        call,
        value,
        `/${field}/${index}`,
        MAX_REPORT_LIST_ITEM_CHARACTERS,
        issues,
      );
    });
  }

  if (output.perQuestion.length !== call.questions.length) {
    issues.push(
      issue(
        "/perQuestion",
        "question_coverage_mismatch",
        `Per-question analysis must contain exactly ${call.questions.length} items`,
      ),
    );
  }

  output.perQuestion.forEach((analysis, index) => {
    const expectedQuestion = call.questions[index];
    const actualQuestion = questionById.get(parseQuestionId(analysis.questionId));
    if (
      expectedQuestion === undefined ||
      String(analysis.questionId) !== String(expectedQuestion.questionId)
    ) {
      issues.push(
        issue(
          `/perQuestion/${index}/questionId`,
          "question_order_mismatch",
          "Question IDs must exactly match the supplied question order",
        ),
      );
    }
    if (actualQuestion === undefined) {
      issues.push(
        issue(
          `/perQuestion/${index}/questionId`,
          "unknown_question_id",
          "Question ID must be one of the supplied server-owned IDs",
        ),
      );
    }

    totalOutputCharacters += validateText(
      call,
      analysis.answerSummary,
      `/perQuestion/${index}/answerSummary`,
      MAX_REPORT_QUESTION_TEXT_CHARACTERS,
      issues,
    );
    totalOutputCharacters += validateText(
      call,
      analysis.scoreRationale,
      `/perQuestion/${index}/scoreRationale`,
      MAX_REPORT_QUESTION_TEXT_CHARACTERS,
      issues,
    );
    if (analysis.improvementSuggestions.length > MAX_REPORT_QUESTION_SUGGESTIONS) {
      issues.push(
        issue(
          `/perQuestion/${index}/improvementSuggestions`,
          "too_many_items",
          `At most ${MAX_REPORT_QUESTION_SUGGESTIONS} improvement suggestions are allowed`,
        ),
      );
    }
    analysis.improvementSuggestions.forEach((suggestion, suggestionIndex) => {
      totalOutputCharacters += validateText(
        call,
        suggestion,
        `/perQuestion/${index}/improvementSuggestions/${suggestionIndex}`,
        MAX_REPORT_LIST_ITEM_CHARACTERS,
        issues,
      );
    });

    if (actualQuestion === undefined) {
      return;
    }
    validateOutcomeLanguage(actualQuestion.outcome, analysis, `/perQuestion/${index}`, issues);
    const suppliedEvidence = new Set(actualQuestion.acceptedEvidenceIds);
    const outputEvidence = new Set(
      analysis.evidenceMaterialIds.map((id) => parseAnswerMaterialId(id)),
    );
    analysis.evidenceMaterialIds.forEach((id, evidenceIndex) => {
      if (!suppliedEvidence.has(parseAnswerMaterialId(id))) {
        issues.push(
          issue(
            `/perQuestion/${index}/evidenceMaterialIds/${evidenceIndex}`,
            "unknown_evidence_id",
            "Evidence ID must belong to this supplied question",
          ),
        );
      }
    });
    if (actualQuestion.requiresAnswerEvidence && outputEvidence.size === 0) {
      issues.push(
        issue(
          `/perQuestion/${index}/evidenceMaterialIds`,
          "missing_question_evidence",
          "Evaluated question analysis requires accepted answer evidence",
        ),
      );
    }
    if (!actualQuestion.requiresAnswerEvidence && outputEvidence.size > 0) {
      issues.push(
        issue(
          `/perQuestion/${index}/evidenceMaterialIds`,
          "unexpected_question_evidence",
          "Unknown or skipped question analysis cannot cite answer evidence",
        ),
      );
    }
    for (const requiredEvidenceId of actualQuestion.requiredEvidenceIds) {
      if (!outputEvidence.has(requiredEvidenceId)) {
        issues.push(
          issue(
            `/perQuestion/${index}/evidenceMaterialIds`,
            "missing_award_evidence",
            "Question analysis must retain every evidence reference used by awarded facts",
          ),
        );
      }
    }
  });
  validateAggregateOutcomeLanguage(call, output, issues);
  const visibleTextFields = [
    output.overallExplanation,
    ...output.strengths,
    ...output.weaknesses,
    ...output.priorities,
    ...output.learningSuggestions,
    ...output.perQuestion.flatMap((analysis) => [
      analysis.answerSummary,
      analysis.scoreRationale,
      ...analysis.improvementSuggestions,
    ]),
  ];
  if (
    !issues.some(({ code }) => code === "private_content_leak") &&
    exposesFragmentedPrivateContent(visibleTextFields, call)
  ) {
    issues.push(
      issue(
        "/",
        "private_content_leak",
        "Combined report text must not expose fragmented internal assessment or reference-answer content",
      ),
    );
  }

  if (totalOutputCharacters > call.outputCharacterBudget) {
    issues.push(
      issue(
        "/",
        "output_too_long",
        `Report analysis text must total at most ${call.outputCharacterBudget} characters for the selected model`,
      ),
    );
  }
  return issues;
}

function validateAggregateOutcomeLanguage(
  call: PreparedReportAnalysisCall,
  output: ModelReportAnalysisOutputDto,
  issues: ReportAnalysisValidationIssue[],
): void {
  const globalText = [
    output.overallExplanation,
    ...output.strengths,
    ...output.weaknesses,
    ...output.priorities,
    ...output.learningSuggestions,
  ].join("\n");
  const allZero = call.questions.every(({ outcome }) => outcome.score === 0);
  const allFullyCorrect = call.questions.every(
    ({ outcome }) => outcome.kind === "scored" && outcome.score === 100,
  );
  if (
    (allZero && ZERO_OUTCOME_POSITIVE_PATTERN.test(globalText)) ||
    (!allFullyCorrect && FULL_CORRECTNESS_PATTERN.test(globalText))
  ) {
    issues.push(
      issue(
        "/",
        "aggregate_outcome_contradiction",
        "Global report text must remain consistent with deterministic question outcomes",
      ),
    );
  }
}

function validateText(
  call: PreparedReportAnalysisCall,
  value: string,
  path: string,
  maximumCharacters: number,
  issues: ReportAnalysisValidationIssue[],
): number {
  const length = characterCount(value);
  if (value.trim().length === 0 || length > maximumCharacters) {
    issues.push(
      issue(path, "invalid_text_length", `Text must contain 1-${maximumCharacters} characters`),
    );
  }
  if (!isMeaningfulSimplifiedChineseText(value)) {
    issues.push(
      issue(
        path,
        "output_language",
        "Analysis text must use meaningful Simplified Chinese while preserving technical terms",
      ),
    );
  }
  if (exposesPrivateContent(value, call)) {
    issues.push(
      issue(
        path,
        "private_content_leak",
        "Text must not expose internal assessment or reference-answer content",
      ),
    );
  }
  if (CANONICAL_CLAIM_PATTERN.test(value)) {
    issues.push(
      issue(
        path,
        "canonical_fact_claim",
        "Analysis text must not state report kind or numeric score facts",
      ),
    );
  }
  return length;
}

function validateOutcomeLanguage(
  outcome: QuestionOutcome,
  analysis: ModelReportAnalysisOutputDto["perQuestion"][number],
  path: string,
  issues: ReportAnalysisValidationIssue[],
): void {
  const text = [
    analysis.answerSummary,
    analysis.scoreRationale,
    ...analysis.improvementSuggestions,
  ].join("\n");
  if (outcome.score === 0 && ZERO_OUTCOME_POSITIVE_PATTERN.test(text)) {
    issues.push(
      issue(
        path,
        "outcome_contradiction",
        "Zero-point analysis must not describe the answer as correct or successful",
      ),
    );
  }
  if (outcome.kind === "scored" && SCORED_OUTCOME_NEGATIVE_PATTERN.test(text)) {
    issues.push(
      issue(
        path,
        "outcome_contradiction",
        "Positive-score analysis must not describe the question as unanswered or wholly incorrect",
      ),
    );
  }
  if (outcome.kind === "scored" && outcome.score < 100 && FULL_CORRECTNESS_PATTERN.test(text)) {
    issues.push(
      issue(
        path,
        "outcome_contradiction",
        "Partial-score analysis must not describe the answer as fully correct",
      ),
    );
  }
  if (
    (outcome.kind !== "unknown" && UNKNOWN_REASON_PATTERN.test(text)) ||
    (outcome.kind !== "skipped" && SKIPPED_REASON_PATTERN.test(text)) ||
    (outcome.kind !== "irrelevant" && IRRELEVANT_REASON_PATTERN.test(text)) ||
    (outcome.kind !== "incorrect" && INCORRECT_REASON_PATTERN.test(text))
  ) {
    issues.push(
      issue(
        path,
        "zero_reason_contradiction",
        "Analysis text must not claim a different deterministic zero-point reason",
      ),
    );
  }
}

function createRepairInput(
  initialInput: string,
  issues: readonly ReportAnalysisValidationIssue[],
  invalidOutput: unknown,
): string {
  return `${initialInput}
<TRUSTED_STRUCTURE_REPAIR>
validationIssues=${trustedJson(sanitizeIssues(issues))}
Repair only the listed structural, coverage, evidence, bounds, or leakage violations. Preserve all trusted question, evidence, outcome, score, domain, and version facts. Submit exactly one corrected value through the supplied output tool.
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
  call: PreparedReportAnalysisCall,
  output: ModelReportAnalysisOutputDto,
  startedAt: number,
  messages: readonly AssistantMessage[],
): ReportAnalysisResult {
  return Object.freeze({
    overallExplanation: output.overallExplanation,
    strengths: Object.freeze([...output.strengths]),
    weaknesses: Object.freeze([...output.weaknesses]),
    priorities: Object.freeze([...output.priorities]),
    learningSuggestions: Object.freeze([...output.learningSuggestions]),
    perQuestion: Object.freeze(
      output.perQuestion.map((analysis) =>
        Object.freeze({
          questionId: parseQuestionId(analysis.questionId),
          answerSummary: analysis.answerSummary,
          scoreRationale: analysis.scoreRationale,
          improvementSuggestions: Object.freeze([...analysis.improvementSuggestions]),
          evidenceMaterialIds: Object.freeze(
            analysis.evidenceMaterialIds.map(parseAnswerMaterialId),
          ),
        }),
      ),
    ),
    metadata: createMetadata(runtime, call, startedAt, messages),
  });
}

function createMetadata(
  runtime: ModelRuntime,
  call: PreparedReportAnalysisCall,
  startedAt: number,
  messages: readonly AssistantMessage[],
): ModelCallMetadata {
  return Object.freeze({
    provider: runtime.model.provider,
    modelId: runtime.model.id,
    promptVersion: call.promptVersion,
    schemaVersion: call.schemaVersion,
    questionVersion: null,
    purpose: "report_analysis",
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

function issue(path: string, code: string, message: string): ReportAnalysisValidationIssue {
  return { path, code, message };
}

function sanitizeIssues(
  issues: readonly ReportAnalysisValidationIssue[],
): readonly ReportAnalysisValidationIssue[] {
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
    throw new ReportAnalysisModelError("invalid_request");
  }
  return encoded;
}

function renderTemplate(template: string, values: Readonly<Record<string, string>>): string {
  const used = new Set<string>();
  const rendered = template.replace(TEMPLATE_PLACEHOLDER_PATTERN, (_placeholder, key: string) => {
    if (!Object.hasOwn(values, key)) {
      throw new ReportAnalysisModelError("invalid_request");
    }
    used.add(key);
    return values[key] ?? "";
  });
  if (Object.keys(values).some((key) => !used.has(key))) {
    throw new ReportAnalysisModelError("invalid_request");
  }
  return rendered;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const expectedSet = new Set(expected);
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expectedSet.has(key))) {
    throw new TypeError("Unexpected or missing fields");
  }
}

function array(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array`);
  }
  return value;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function integer(
  value: unknown,
  field: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${field} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function literal<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  field: string,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new TypeError(`${field} is invalid`);
  }
  return value as Values[number];
}

function characterCount(value: string): number {
  return [...value].length;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
