import {
  type AccountId,
  type AnswerMaterialId,
  type EvaluationId,
  type FollowUpGoalSnapshot,
  type ImmutableReportSnapshot,
  type Interview,
  type InterviewId,
  InvalidReportSnapshotError,
  type MessageId,
  type ModelCallMetadata,
  parseAccountId,
  parseAnswerMaterialId,
  parseEvaluationId,
  parseFollowUpGoalId,
  parseImmutableReportSnapshot,
  parseInterviewId,
  parseMessageId,
  parseOperationId,
  parsePositiveQuestionScore,
  parseQuestionId,
  parseReportId,
  parseRubricItemId,
  type QuestionEvaluation,
  type QuestionOutcome,
  type ReportId,
  type RubricItemEvaluation,
  type RubricItemId,
  type RubricItemSnapshot,
  scoreQuestion,
  validateRubric,
} from "@interview-agent/domain";

import type { JsonObject, JsonValue } from "../schema/interview.js";
import { RepositoryCorruptionError } from "./errors.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  field: string,
  resource: string,
  identifier: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw corruption(resource, identifier, `${field} must be a non-empty string`);
  }
  return value;
}

function requiredInteger(
  value: unknown,
  field: string,
  resource: string,
  identifier: string,
  minimum = 0,
): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < minimum) {
    throw corruption(resource, identifier, `${field} must be an integer >= ${minimum}`);
  }
  return value;
}

function nullableInteger(
  value: unknown,
  field: string,
  resource: string,
  identifier: string,
): number | null {
  return value === null ? null : requiredInteger(value, field, resource, identifier);
}

function corruption(resource: string, identifier: string, detail: string, cause?: unknown) {
  return new RepositoryCorruptionError(
    resource,
    identifier,
    detail,
    cause instanceof Error ? { cause } : undefined,
  );
}

export function decodeJsonObject(
  value: unknown,
  resource: string,
  identifier: string,
  field: string,
): JsonObject {
  if (!isRecord(value)) {
    throw corruption(resource, identifier, `${field} must be a JSON object`);
  }
  const decoded: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    decoded[key] = decodeJsonValue(item, resource, identifier, `${field}.${key}`);
  }
  return decoded;
}

function decodeJsonValue(
  value: unknown,
  resource: string,
  identifier: string,
  field: string,
): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      decodeJsonValue(item, resource, identifier, `${field}[${index}]`),
    );
  }
  if (isRecord(value)) {
    const decoded: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      decoded[key] = decodeJsonValue(item, resource, identifier, `${field}.${key}`);
    }
    return decoded;
  }
  throw corruption(resource, identifier, `${field} contains a non-JSON value`);
}

export function decodeRubric(
  value: unknown,
  interviewId: string,
  position: number,
): readonly RubricItemSnapshot[] {
  return decodeRubricAt(value, {
    resource: "interview",
    identifier: interviewId,
    field: `question ${position} rubric`,
  });
}

export interface QuestionStructureDecodeContext {
  readonly resource: string;
  readonly identifier: string;
  readonly field: string;
}

export function decodeRubricAt(
  value: unknown,
  context: QuestionStructureDecodeContext,
): readonly RubricItemSnapshot[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw corruption(
      context.resource,
      context.identifier,
      `${context.field} must be a non-empty array`,
    );
  }
  const rubric = value.map((item, index) => {
    if (!isRecord(item)) {
      throw corruption(context.resource, context.identifier, `${context.field}[${index}] invalid`);
    }
    try {
      return {
        id: parseRubricItemId(
          requiredString(item["id"], "id", context.resource, context.identifier),
        ),
        description: requiredString(
          item["description"],
          "description",
          context.resource,
          context.identifier,
        ),
        weight: requiredInteger(item["weight"], "weight", context.resource, context.identifier, 1),
      };
    } catch (error) {
      if (error instanceof RepositoryCorruptionError) {
        throw error;
      }
      throw corruption(
        context.resource,
        context.identifier,
        `${context.field}[${index}] invalid`,
        error,
      );
    }
  });
  try {
    validateRubric(rubric);
  } catch (error) {
    throw corruption(
      context.resource,
      context.identifier,
      `${context.field} violates domain rules`,
      error,
    );
  }
  return rubric;
}

export function decodeFollowUpGoals(
  value: unknown,
  interviewId: string,
  position: number,
): readonly FollowUpGoalSnapshot[] {
  return decodeFollowUpGoalsAt(value, {
    resource: "interview",
    identifier: interviewId,
    field: `question ${position} follow-up goals`,
  });
}

export function decodeFollowUpGoalsAt(
  value: unknown,
  context: QuestionStructureDecodeContext,
): readonly FollowUpGoalSnapshot[] {
  if (!Array.isArray(value)) {
    throw corruption(context.resource, context.identifier, `${context.field} must be an array`);
  }
  const goals = value.map((item, index): FollowUpGoalSnapshot => {
    if (!isRecord(item)) {
      throw corruption(context.resource, context.identifier, `${context.field}[${index}] invalid`);
    }
    const kind = item["kind"];
    if (kind !== "clarification" && kind !== "depth") {
      throw corruption(
        context.resource,
        context.identifier,
        `${context.field}[${index}].kind invalid`,
      );
    }
    try {
      return {
        id: parseFollowUpGoalId(
          requiredString(item["id"], "id", context.resource, context.identifier),
        ),
        kind,
        goal: requiredString(item["goal"], "goal", context.resource, context.identifier),
      };
    } catch (error) {
      if (error instanceof RepositoryCorruptionError) {
        throw error;
      }
      throw corruption(
        context.resource,
        context.identifier,
        `${context.field}[${index}] invalid`,
        error,
      );
    }
  });
  const goalIds = new Set<string>();
  let hasClarification = false;
  for (const goal of goals) {
    if (goalIds.has(goal.id)) {
      throw corruption(
        context.resource,
        context.identifier,
        `${context.field} has duplicate goal ${goal.id}`,
      );
    }
    goalIds.add(goal.id);
    hasClarification ||= goal.kind === "clarification";
  }
  if (!hasClarification) {
    throw corruption(
      context.resource,
      context.identifier,
      `${context.field} has no clarification goal`,
    );
  }
  return goals;
}

export function decodeRubricEvaluations(
  value: unknown,
  interviewId: string,
  evaluationId: string,
): readonly RubricItemEvaluation[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw corruption(
      "interview",
      interviewId,
      `evaluation ${evaluationId} rubric results must be non-empty`,
    );
  }
  return value.map((item, index) => {
    if (!isRecord(item) || !Array.isArray(item["evidenceMaterialIds"])) {
      throw corruption(
        "interview",
        interviewId,
        `evaluation ${evaluationId} rubricResults[${index}] invalid`,
      );
    }
    if (!Array.isArray(item["missingOrIncorrectPoints"])) {
      throw corruption(
        "interview",
        interviewId,
        `evaluation ${evaluationId} missing points invalid`,
      );
    }
    let rubricItemId: RubricItemId;
    let evidenceMaterialIds: readonly AnswerMaterialId[];
    try {
      rubricItemId = parseRubricItemId(
        requiredString(item["rubricItemId"], "rubricItemId", "interview", interviewId),
      );
      evidenceMaterialIds = item["evidenceMaterialIds"].map((materialId) =>
        parseAnswerMaterialId(
          requiredString(materialId, "evidenceMaterialId", "interview", interviewId),
        ),
      );
    } catch (error) {
      if (error instanceof RepositoryCorruptionError) {
        throw error;
      }
      throw corruption(
        "interview",
        interviewId,
        `evaluation ${evaluationId} identifiers invalid`,
        error,
      );
    }
    return {
      rubricItemId,
      evidenceMaterialIds,
      awardedPoints: requiredInteger(
        item["awardedPoints"],
        "awardedPoints",
        "interview",
        interviewId,
      ),
      missingOrIncorrectPoints: item["missingOrIncorrectPoints"].map((point) =>
        requiredString(point, "missingOrIncorrectPoint", "interview", interviewId),
      ),
    };
  });
}

export function decodeQuestionEvaluation(input: {
  readonly interviewId: string;
  readonly evaluationId: string;
  readonly classification: string;
  readonly rubricResults: unknown;
  readonly outcomeKind: string;
  readonly score: number;
  readonly zeroScoreReason: string | null;
  readonly rubric: readonly RubricItemSnapshot[];
  readonly answerMaterialIds: ReadonlySet<AnswerMaterialId>;
}): QuestionEvaluation {
  if (
    input.classification !== "relevant" &&
    input.classification !== "ambiguous" &&
    input.classification !== "irrelevant"
  ) {
    throw corruption(
      "interview",
      input.interviewId,
      `evaluation ${input.evaluationId} classification invalid`,
    );
  }
  let evaluationId: EvaluationId;
  try {
    evaluationId = parseEvaluationId(input.evaluationId);
  } catch (error) {
    throw corruption("interview", input.interviewId, "evaluation ID invalid", error);
  }
  const rubricItems = decodeRubricEvaluations(
    input.rubricResults,
    input.interviewId,
    input.evaluationId,
  );
  let evaluation: QuestionEvaluation;
  try {
    evaluation = scoreQuestion({
      rubric: input.rubric,
      evaluation: {
        id: evaluationId,
        classification: input.classification,
        rubricItems,
      },
      validEvidenceMaterialIds: input.answerMaterialIds,
    });
  } catch (error) {
    throw corruption(
      "interview",
      input.interviewId,
      `evaluation ${input.evaluationId} violates domain scoring rules`,
      error,
    );
  }
  if (
    evaluation.outcome.kind !== input.outcomeKind ||
    evaluation.outcome.score !== input.score ||
    ("zeroScoreReason" in evaluation.outcome
      ? evaluation.outcome.zeroScoreReason !== input.zeroScoreReason
      : input.zeroScoreReason !== null)
  ) {
    throw corruption(
      "interview",
      input.interviewId,
      `evaluation ${input.evaluationId} outcome columns disagree with rubric results`,
    );
  }
  return evaluation;
}

export function decodeSnapshotOutcome(input: {
  readonly interviewId: string;
  readonly position: number;
  readonly outcomeKind: string | null;
  readonly score: number | null;
  readonly zeroScoreReason: string | null;
}): QuestionOutcome | null {
  if (input.outcomeKind === null) {
    if (input.score !== null || input.zeroScoreReason !== null) {
      throw corruption(
        "interview",
        input.interviewId,
        `question ${input.position} null outcome has score data`,
      );
    }
    return null;
  }
  if (input.outcomeKind === "scored") {
    if (
      input.score === null ||
      !Number.isInteger(input.score) ||
      input.score < 1 ||
      input.score > 100 ||
      input.zeroScoreReason !== null
    ) {
      throw corruption(
        "interview",
        input.interviewId,
        `question ${input.position} scored outcome invalid`,
      );
    }
    return { kind: "scored", score: parsePositiveQuestionScore(input.score) };
  }
  if (
    input.outcomeKind !== "incorrect" &&
    input.outcomeKind !== "unknown" &&
    input.outcomeKind !== "skipped" &&
    input.outcomeKind !== "irrelevant"
  ) {
    throw corruption(
      "interview",
      input.interviewId,
      `question ${input.position} outcome kind invalid`,
    );
  }
  if (input.score !== 0 || input.zeroScoreReason !== input.outcomeKind) {
    throw corruption(
      "interview",
      input.interviewId,
      `question ${input.position} zero outcome columns disagree`,
    );
  }
  switch (input.outcomeKind) {
    case "incorrect":
      return { kind: "incorrect", score: 0, zeroScoreReason: "incorrect" };
    case "unknown":
      return { kind: "unknown", score: 0, zeroScoreReason: "unknown" };
    case "skipped":
      return { kind: "skipped", score: 0, zeroScoreReason: "skipped" };
    case "irrelevant":
      return { kind: "irrelevant", score: 0, zeroScoreReason: "irrelevant" };
  }
}

export function decodeModelMetadata(
  value: unknown,
  resource: string,
  identifier: string,
): ModelCallMetadata {
  if (!isRecord(value)) {
    throw corruption(resource, identifier, "model metadata must be an object");
  }
  return {
    provider: requiredString(value["provider"], "provider", resource, identifier),
    modelId: requiredString(value["modelId"], "modelId", resource, identifier),
    promptVersion: requiredString(value["promptVersion"], "promptVersion", resource, identifier),
    schemaVersion: requiredString(value["schemaVersion"], "schemaVersion", resource, identifier),
    questionVersion:
      value["questionVersion"] === null
        ? null
        : requiredInteger(value["questionVersion"], "questionVersion", resource, identifier, 1),
    purpose: requiredString(value["purpose"], "purpose", resource, identifier),
    latencyMs: requiredInteger(value["latencyMs"], "latencyMs", resource, identifier),
    inputTokens: nullableInteger(value["inputTokens"], "inputTokens", resource, identifier),
    outputTokens: nullableInteger(value["outputTokens"], "outputTokens", resource, identifier),
  };
}

export function decodeReportSnapshot(input: {
  readonly value: unknown;
  readonly reportId: string;
  readonly interviewId: InterviewId;
  readonly accountId: AccountId;
  readonly kind: "complete" | "incomplete";
  readonly schemaVersion: string;
  readonly createdAt: Date;
  readonly modelMetadata: ModelCallMetadata;
}): ImmutableReportSnapshot {
  let snapshot: ImmutableReportSnapshot;
  try {
    snapshot = parseImmutableReportSnapshot(input.value);
  } catch (error) {
    throw corruption(
      "report",
      input.reportId,
      "snapshot violates immutable report rules",
      error instanceof InvalidReportSnapshotError ? error : undefined,
    );
  }
  if (
    snapshot.interviewId !== input.interviewId ||
    snapshot.reportId !== input.reportId ||
    snapshot.accountId !== input.accountId ||
    snapshot.kind !== input.kind
  ) {
    throw corruption(
      "report",
      input.reportId,
      "snapshot identity or report kind does not match relational columns",
    );
  }
  if (input.schemaVersion.trim().length === 0 || snapshot.schemaVersion !== input.schemaVersion) {
    throw corruption(
      "report",
      input.reportId,
      "snapshot schemaVersion does not match relational schemaVersion",
    );
  }
  if (
    !Number.isFinite(input.createdAt.getTime()) ||
    new Date(snapshot.generatedAt).getTime() !== input.createdAt.getTime()
  ) {
    throw corruption(
      "report",
      input.reportId,
      "snapshot generatedAt does not match relational createdAt",
    );
  }
  const metadata = snapshot.modelMetadata;
  if (
    metadata.provider !== input.modelMetadata.provider ||
    metadata.modelId !== input.modelMetadata.modelId ||
    metadata.promptVersion !== input.modelMetadata.promptVersion ||
    metadata.schemaVersion !== input.modelMetadata.schemaVersion ||
    metadata.questionVersion !== input.modelMetadata.questionVersion ||
    metadata.purpose !== input.modelMetadata.purpose ||
    metadata.latencyMs !== input.modelMetadata.latencyMs ||
    metadata.tokens.inputTokens !== input.modelMetadata.inputTokens ||
    metadata.tokens.outputTokens !== input.modelMetadata.outputTokens
  ) {
    throw corruption(
      "report",
      input.reportId,
      "snapshot model metadata does not match relational model metadata",
    );
  }
  return snapshot;
}

export function decodeAccountId(value: string, resource: string, identifier: string): AccountId {
  try {
    return parseAccountId(value);
  } catch (error) {
    throw corruption(resource, identifier, "account ID invalid", error);
  }
}

export function decodeInterviewId(
  value: string,
  resource: string,
  identifier: string,
): InterviewId {
  try {
    return parseInterviewId(value);
  } catch (error) {
    throw corruption(resource, identifier, "interview ID invalid", error);
  }
}

export function decodeMessageId(value: string, interviewId: string): MessageId {
  try {
    return parseMessageId(value);
  } catch (error) {
    throw corruption("interview", interviewId, "message ID invalid", error);
  }
}

export function decodeOperationId(value: string, resource: string, identifier: string) {
  try {
    return parseOperationId(value);
  } catch (error) {
    throw corruption(resource, identifier, "Operation ID invalid", error);
  }
}

export function decodeQuestionId(value: string, interviewId: string) {
  try {
    return parseQuestionId(value);
  } catch (error) {
    throw corruption("interview", interviewId, "question ID invalid", error);
  }
}

export function decodeReportId(value: string, resource: string, identifier: string): ReportId {
  try {
    return parseReportId(value);
  } catch (error) {
    throw corruption(resource, identifier, "report ID invalid", error);
  }
}

export function decodeAnswerMaterialId(value: string, interviewId: string) {
  try {
    return parseAnswerMaterialId(value);
  } catch (error) {
    throw corruption("interview", interviewId, "answer material ID invalid", error);
  }
}

export function requireRecordMetadata(
  value: unknown,
  interviewId: string,
  messageId: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw corruption("interview", interviewId, `message ${messageId} metadata invalid`);
  }
  return value;
}

export function requiredMetadataString(
  metadata: Record<string, unknown>,
  key: string,
  interviewId: string,
  messageId: string,
): string {
  return requiredString(metadata[key], `message ${messageId} ${key}`, "interview", interviewId);
}

export function assertReportMatchesInterview(
  snapshot: ImmutableReportSnapshot,
  interview: Interview,
): void {
  const expectedQuestions =
    snapshot.kind === "complete"
      ? interview.questions
      : interview.questions.filter((question) => question.outcome !== null);
  if (snapshot.questions.length !== expectedQuestions.length) {
    throw corruption(
      "report",
      snapshot.reportId,
      "question feedback does not cover the aggregate outcomes",
    );
  }

  for (const feedback of snapshot.questions) {
    const question = interview.questions[feedback.position - 1];
    const blueprint = interview.blueprint.questions[feedback.position - 1];
    if (
      question === undefined ||
      blueprint === undefined ||
      question.outcome === null ||
      blueprint.position !== feedback.position ||
      blueprint.question.questionId !== feedback.questionId ||
      blueprint.question.questionVersion !== feedback.questionVersion ||
      blueprint.question.domain !== feedback.domain ||
      blueprint.question.displayedWording !== feedback.displayedQuestion ||
      question.outcome.kind !== feedback.outcome ||
      question.outcome.score !== feedback.score ||
      (question.outcome.kind === "scored"
        ? "zeroScoreReason" in feedback
        : !("zeroScoreReason" in feedback) ||
          question.outcome.zeroScoreReason !== feedback.zeroScoreReason)
    ) {
      throw corruption(
        "report",
        snapshot.reportId,
        `question feedback at position ${feedback.position} disagrees with the aggregate`,
      );
    }

    const rubricById = new Map(blueprint.question.rubric.map((item) => [item.id, item] as const));
    const evaluationByRubricId = new Map(
      question.evaluation?.rubricItems.map((item) => [item.rubricItemId, item] as const) ?? [],
    );
    const evaluationEvidenceIds = new Set(
      question.evaluation?.rubricItems.flatMap((item) => item.evidenceMaterialIds) ?? [],
    );
    const materialIds = new Set(question.answerMaterial.map((material) => material.id));

    for (const evidence of feedback.evidence) {
      if (
        (evidence.source === "question_snapshot" &&
          evidence.questionId !== blueprint.question.questionId) ||
        (evidence.source === "answer_material" &&
          (!materialIds.has(evidence.answerMaterialId) ||
            (question.evaluation !== null &&
              !evaluationEvidenceIds.has(evidence.answerMaterialId))))
      ) {
        throw corruption(
          "report",
          snapshot.reportId,
          `question ${feedback.position} contains an invalid evidence claim`,
        );
      }
    }

    for (const point of feedback.matchedKnowledgePoints) {
      const evaluation = evaluationByRubricId.get(point.rubricItemId);
      if (
        !rubricById.has(point.rubricItemId) ||
        evaluation === undefined ||
        evaluation.awardedPoints <= 0 ||
        point.awardedPoints !== evaluation.awardedPoints
      ) {
        throw corruption(
          "report",
          snapshot.reportId,
          `question ${feedback.position} matched Rubric award disagrees with evaluation`,
        );
      }
      assertPointEvidenceMatchesEvaluation(
        snapshot,
        feedback.position,
        point.evidence,
        evaluation.evidenceMaterialIds,
      );
    }

    for (const point of feedback.missingOrIncorrectPoints) {
      if (!rubricById.has(point.rubricItemId)) {
        throw corruption(
          "report",
          snapshot.reportId,
          `question ${feedback.position} references an unknown Rubric item`,
        );
      }
      const evaluation = evaluationByRubricId.get(point.rubricItemId);
      if (
        evaluation !== undefined &&
        !evaluation.missingOrIncorrectPoints.includes(point.summary)
      ) {
        throw corruption(
          "report",
          snapshot.reportId,
          `question ${feedback.position} missing or incorrect point disagrees with evaluation`,
        );
      }
      if (
        evaluation === undefined &&
        question.outcome.kind !== "unknown" &&
        question.outcome.kind !== "skipped"
      ) {
        throw corruption(
          "report",
          snapshot.reportId,
          `question ${feedback.position} missing point has no persisted evaluation fact`,
        );
      }
      assertPointEvidenceMatchesEvaluation(
        snapshot,
        feedback.position,
        point.evidence,
        evaluation?.evidenceMaterialIds ?? [],
      );
    }
  }
}

function assertPointEvidenceMatchesEvaluation(
  snapshot: ImmutableReportSnapshot,
  position: number,
  evidence: ImmutableReportSnapshot["questions"][number]["evidence"],
  evaluationEvidenceIds: readonly AnswerMaterialId[],
): void {
  const persistedEvidenceIds = new Set(evaluationEvidenceIds);
  if (
    evidence.some(
      (reference) =>
        reference.source === "answer_material" &&
        !persistedEvidenceIds.has(reference.answerMaterialId),
    )
  ) {
    throw corruption(
      "report",
      snapshot.reportId,
      `question ${position} Rubric evidence disagrees with evaluation`,
    );
  }
}
