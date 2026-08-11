import {
  isMeaningfulSimplifiedChineseText,
  ModelAnswerEvaluationOutputSchema,
} from "@interview-agent/contracts";
import {
  InvalidRubricAwardError,
  parseAnswerMaterialId,
  parseEvaluationId,
  parseFollowUpGoalId,
  parseQuestionId,
  parseRubricItemId,
  scoreQuestion,
  validateRubric,
} from "@interview-agent/domain";
import { Check } from "typebox/value";
import {
  MAX_MISSING_OR_INCORRECT_POINT_CHARACTERS,
  MAX_MISSING_OR_INCORRECT_POINTS_PER_ITEM,
  MAX_MISSING_OR_INCORRECT_TOTAL_CHARACTERS,
} from "../../src/answer-evaluation-model.js";
import {
  CURRENT_MODEL_PROMPT_VERSIONS,
  CURRENT_MODEL_SCHEMA_VERSIONS,
} from "../../src/model-contract-registry.js";
import {
  EVALUATION_FIXTURE_CATEGORIES,
  type EvaluationFixture,
  type EvaluationFixtureSuite,
  type ModelEvaluatedEvaluationFixture,
} from "./evaluation-fixtures.js";

const STABLE_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const SUPPORTED_CATEGORIES = new Set<string>(EVALUATION_FIXTURE_CATEGORIES);

export interface EvaluationFixtureValidationIssue {
  readonly caseId: string | null;
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export function validateEvaluationFixtureSuite(
  suite: EvaluationFixtureSuite,
): readonly EvaluationFixtureValidationIssue[] {
  const issues: EvaluationFixtureValidationIssue[] = [];
  const caseIds = new Set<string>();
  const coveredCategories = new Set<string>();

  if (
    suite.fixtureSchemaVersion !== "evaluation-fixture-suite-v1" ||
    !STABLE_ID_PATTERN.test(suite.suiteId) ||
    !Number.isInteger(suite.suiteVersion) ||
    suite.suiteVersion < 1
  ) {
    issues.push(issue(null, "/", "invalid_suite_version", "Fixture suite metadata is invalid"));
  }
  if (
    suite.modelContract.purpose !== "answer_evaluation" ||
    suite.modelContract.promptVersion !== CURRENT_MODEL_PROMPT_VERSIONS.answer_evaluation ||
    suite.modelContract.schemaVersion !== CURRENT_MODEL_SCHEMA_VERSIONS.answer_evaluation
  ) {
    issues.push(
      issue(
        null,
        "/modelContract",
        "invalid_model_contract_version",
        "Fixture model-contract metadata must stay pinned to the evaluated prompt and Schema",
      ),
    );
  }

  for (const fixture of suite.cases) {
    if (
      !STABLE_ID_PATTERN.test(fixture.caseId) ||
      !Number.isInteger(fixture.caseVersion) ||
      fixture.caseVersion < 1
    ) {
      issues.push(
        issue(
          fixture.caseId,
          "/caseId",
          "invalid_case_version",
          "Case ID and version metadata must be stable",
        ),
      );
    }
    if (caseIds.has(fixture.caseId)) {
      issues.push(issue(fixture.caseId, "/caseId", "duplicate_case_id", "Case IDs must be unique"));
    }
    caseIds.add(fixture.caseId);

    if (!SUPPORTED_CATEGORIES.has(fixture.category)) {
      issues.push(
        issue(
          fixture.caseId,
          "/category",
          "unsupported_category",
          "Fixture category is not supported",
        ),
      );
    } else {
      coveredCategories.add(fixture.category);
    }

    validateQuestion(fixture, issues);
    validateAnswerMaterial(fixture, issues);
    if (fixture.execution === "model_evaluated") {
      validateModelEvaluatedFixture(fixture, issues);
    } else {
      validateExplicitZeroOutcomeFixture(fixture, issues);
    }
    validateCategorySemantics(fixture, issues);
    validateUntrustedInputStrings(fixture, issues);
  }

  for (const category of EVALUATION_FIXTURE_CATEGORIES) {
    if (!coveredCategories.has(category)) {
      issues.push(
        issue(null, "/cases", "missing_category", `Fixture suite must cover category ${category}`),
      );
    }
  }

  return Object.freeze(issues);
}

function validateQuestion(
  fixture: EvaluationFixture,
  issues: EvaluationFixtureValidationIssue[],
): void {
  try {
    parseQuestionId(fixture.question.questionId);
    if (
      !Number.isInteger(fixture.question.questionVersion) ||
      fixture.question.questionVersion < 1
    ) {
      throw new Error("Question version must be positive");
    }
  } catch {
    issues.push(
      issue(
        fixture.caseId,
        "/question",
        "invalid_question_identity",
        "Question ID and version must satisfy domain rules",
      ),
    );
  }
  try {
    validateRubric(fixture.question.rubric);
  } catch (error) {
    issues.push(
      issue(
        fixture.caseId,
        "/question/rubric",
        "invalid_rubric",
        error instanceof Error ? error.message : "Rubric is invalid",
      ),
    );
  }

  const goalIds = new Set<string>();
  for (const [index, goal] of fixture.question.followUpGoals.entries()) {
    try {
      parseFollowUpGoalId(goal.id);
    } catch {
      issues.push(
        issue(
          fixture.caseId,
          `/question/followUpGoals/${index}/id`,
          "invalid_follow_up_goal_id",
          "Follow-up goal ID must satisfy domain rules",
        ),
      );
    }
    if (goalIds.has(goal.id)) {
      issues.push(
        issue(
          fixture.caseId,
          `/question/followUpGoals/${index}/id`,
          "duplicate_follow_up_goal",
          "Follow-up goal IDs must be unique",
        ),
      );
    }
    goalIds.add(goal.id);
  }

  for (const candidate of [
    { path: "/question/sourceWording", text: fixture.question.sourceWording },
    { path: "/question/displayedWording", text: fixture.question.displayedWording },
    ...fixture.question.rubric.map((item, index) => ({
      path: `/question/rubric/${index}/description`,
      text: item.description,
    })),
    ...fixture.question.followUpGoals.map((goal, index) => ({
      path: `/question/followUpGoals/${index}/goal`,
      text: goal.goal,
    })),
    {
      path: "/question/knowledgeExplanation",
      text: fixture.question.knowledgeExplanation,
    },
  ]) {
    requireSimplifiedChinese(fixture.caseId, candidate.path, candidate.text, issues);
  }
}

function validateAnswerMaterial(
  fixture: EvaluationFixture,
  issues: EvaluationFixtureValidationIssue[],
): void {
  const materialIds = new Set<string>();
  for (const [index, material] of fixture.answerMaterial.entries()) {
    try {
      parseAnswerMaterialId(material.id);
    } catch {
      issues.push(
        issue(
          fixture.caseId,
          `/answerMaterial/${index}/id`,
          "invalid_answer_material_id",
          "Answer-material ID must satisfy domain rules",
        ),
      );
    }
    if (materialIds.has(material.id)) {
      issues.push(
        issue(
          fixture.caseId,
          `/answerMaterial/${index}/id`,
          "duplicate_answer_material_id",
          "Answer-material IDs must be unique within a case",
        ),
      );
    }
    materialIds.add(material.id);
    if (
      typeof material.submittedAt !== "string" ||
      !Number.isFinite(Date.parse(material.submittedAt))
    ) {
      issues.push(
        issue(
          fixture.caseId,
          `/answerMaterial/${index}/submittedAt`,
          "invalid_submission_time",
          "Answer-material submission time must be valid",
        ),
      );
    }
    requireSimplifiedChinese(
      fixture.caseId,
      `/answerMaterial/${index}/text`,
      material.text,
      issues,
    );
  }
}

function validateModelEvaluatedFixture(
  fixture: ModelEvaluatedEvaluationFixture,
  issues: EvaluationFixtureValidationIssue[],
): void {
  if (fixture.answerMaterial.length === 0) {
    issues.push(
      issue(
        fixture.caseId,
        "/answerMaterial",
        "missing_answer_material",
        "Model-evaluated cases require answer material",
      ),
    );
  }
  const followUpAnswerCount = fixture.answerMaterial.filter(
    ({ kind }) => kind === "follow_up_answer",
  ).length;
  if (followUpAnswerCount !== fixture.usedFollowUpGoalIds.length) {
    issues.push(
      issue(
        fixture.caseId,
        "/usedFollowUpGoalIds",
        "follow_up_state_mismatch",
        "Follow-up answers and used snapshot goals must have matching counts",
      ),
    );
  }
  const goalIds = new Set(fixture.question.followUpGoals.map(({ id }) => String(id)));
  for (const [index, goalId] of fixture.usedFollowUpGoalIds.entries()) {
    try {
      const parsed = parseFollowUpGoalId(goalId);
      if (!goalIds.has(parsed)) {
        throw new Error("Unknown follow-up goal");
      }
    } catch {
      issues.push(
        issue(
          fixture.caseId,
          `/usedFollowUpGoalIds/${index}`,
          "invalid_used_follow_up_goal",
          "Used follow-up IDs must reference valid snapshot goals",
        ),
      );
    }
  }
  if (!Check(ModelAnswerEvaluationOutputSchema, fixture.modelOutput)) {
    issues.push(
      issue(
        fixture.caseId,
        "/modelOutput",
        "invalid_model_output_schema",
        "Fixture model output must conform to the registered evaluation Schema",
      ),
    );
  }
  if (fixture.modelOutput.classification !== fixture.expected.classification) {
    issues.push(
      issue(
        fixture.caseId,
        "/expected/classification",
        "expected_classification_mismatch",
        "Expected classification must match the fixture model output",
      ),
    );
  }

  for (const [itemIndex, rubricItem] of fixture.modelOutput.rubricItems.entries()) {
    const sourceRubricItem = fixture.question.rubric.find(
      ({ id }) => String(id) === String(rubricItem.rubricItemId),
    );
    if (
      sourceRubricItem !== undefined &&
      rubricItem.awardedPoints < sourceRubricItem.weight &&
      rubricItem.missingOrIncorrectPoints.length === 0
    ) {
      issues.push(
        issue(
          fixture.caseId,
          `/modelOutput/rubricItems/${itemIndex}/missingOrIncorrectPoints`,
          "missing_points_required",
          "Under-awarded Rubric items require missing or incorrect points",
        ),
      );
    }
    if (
      sourceRubricItem !== undefined &&
      rubricItem.awardedPoints === sourceRubricItem.weight &&
      rubricItem.missingOrIncorrectPoints.length > 0
    ) {
      issues.push(
        issue(
          fixture.caseId,
          `/modelOutput/rubricItems/${itemIndex}/missingOrIncorrectPoints`,
          "unexpected_missing_points",
          "Fully awarded Rubric items cannot report missing or incorrect points",
        ),
      );
    }
    if (rubricItem.missingOrIncorrectPoints.length > MAX_MISSING_OR_INCORRECT_POINTS_PER_ITEM) {
      issues.push(
        issue(
          fixture.caseId,
          `/modelOutput/rubricItems/${itemIndex}/missingOrIncorrectPoints`,
          "too_many_missing_points",
          "Missing or incorrect point count exceeds the production bound",
        ),
      );
    }
    for (const [pointIndex, point] of rubricItem.missingOrIncorrectPoints.entries()) {
      if ([...point].length > MAX_MISSING_OR_INCORRECT_POINT_CHARACTERS) {
        issues.push(
          issue(
            fixture.caseId,
            `/modelOutput/rubricItems/${itemIndex}/missingOrIncorrectPoints/${pointIndex}`,
            "invalid_missing_point_length",
            "Missing or incorrect point text exceeds the production bound",
          ),
        );
      }
      requireSimplifiedChinese(
        fixture.caseId,
        `/modelOutput/rubricItems/${itemIndex}/missingOrIncorrectPoints/${pointIndex}`,
        point,
        issues,
      );
    }
  }
  const totalMissingCharacters = fixture.modelOutput.rubricItems.reduce(
    (total, item) =>
      total +
      item.missingOrIncorrectPoints.reduce((itemTotal, point) => itemTotal + [...point].length, 0),
    0,
  );
  if (totalMissingCharacters > MAX_MISSING_OR_INCORRECT_TOTAL_CHARACTERS) {
    issues.push(
      issue(
        fixture.caseId,
        "/modelOutput/rubricItems",
        "missing_points_total_too_long",
        "Missing or incorrect point text exceeds the aggregate production bound",
      ),
    );
  }

  try {
    const evaluation = scoreQuestion({
      rubric: fixture.question.rubric,
      evaluation: {
        id: parseEvaluationId(`${fixture.caseId}.v${fixture.caseVersion}`),
        classification: fixture.modelOutput.classification,
        rubricItems: fixture.modelOutput.rubricItems.map((item) => ({
          rubricItemId: parseRubricItemId(item.rubricItemId),
          evidenceMaterialIds: item.evidenceMaterialIds.map(parseAnswerMaterialId),
          awardedPoints: item.awardedPoints,
          missingOrIncorrectPoints: item.missingOrIncorrectPoints,
        })),
      },
      validEvidenceMaterialIds: new Set(fixture.answerMaterial.map(({ id }) => id)),
    });
    if (!sameOutcome(evaluation.outcome, fixture.expected.outcome)) {
      issues.push(
        issue(
          fixture.caseId,
          "/expected/outcome",
          "expected_outcome_mismatch",
          "Expected outcome and score must match deterministic Rubric scoring",
        ),
      );
    }
  } catch (error) {
    issues.push(
      issue(
        fixture.caseId,
        "/modelOutput/rubricItems",
        error instanceof InvalidRubricAwardError ? error.code : "invalid_model_evaluation",
        error instanceof Error ? error.message : "Model evaluation fixture is invalid",
      ),
    );
  }

  validateRecommendation(fixture, issues);
}

function validateRecommendation(
  fixture: ModelEvaluatedEvaluationFixture,
  issues: EvaluationFixtureValidationIssue[],
): void {
  const output = fixture.modelOutput.recommendedFollowUp;
  const expected = fixture.expected.recommendedFollowUpGoal;
  if (JSON.stringify(output) !== JSON.stringify(expected)) {
    issues.push(
      issue(
        fixture.caseId,
        "/expected/recommendedFollowUpGoal",
        "expected_follow_up_mismatch",
        "Expected follow-up must match the fixture model output",
      ),
    );
  }
  const usedGoals = fixture.question.followUpGoals.filter(({ id }) =>
    fixture.usedFollowUpGoalIds.some((usedId) => usedId === id),
  );
  const usedKinds = new Set(usedGoals.map(({ kind }) => kind));
  if (output === null) {
    if (fixture.modelOutput.classification === "irrelevant" && !usedKinds.has("clarification")) {
      issues.push(
        issue(
          fixture.caseId,
          "/modelOutput/recommendedFollowUp",
          "irrelevant_clarification_required",
          "A first irrelevant response requires an unused clarification follow-up",
        ),
      );
    }
    return;
  }

  const goal = fixture.question.followUpGoals.find(
    ({ id }) => String(id) === String(output.goalId),
  );
  if (
    goal === undefined ||
    goal.kind !== output.kind ||
    fixture.usedFollowUpGoalIds.some((goalId) => String(goalId) === String(output.goalId))
  ) {
    issues.push(
      issue(
        fixture.caseId,
        "/modelOutput/recommendedFollowUp",
        "invalid_follow_up_reference",
        "Recommended follow-up must reference an unused matching snapshot goal",
      ),
    );
  }
  if (usedKinds.has(output.kind)) {
    issues.push(
      issue(
        fixture.caseId,
        "/modelOutput/recommendedFollowUp/kind",
        "follow_up_kind_already_used",
        "Recommended follow-up kind has already been consumed",
      ),
    );
  }
  if (
    (output.kind === "depth" && output.purpose !== "depth") ||
    (output.kind === "clarification" && output.purpose === "depth") ||
    (fixture.modelOutput.classification === "irrelevant" &&
      output.purpose !== "irrelevant_response_clarification") ||
    (fixture.modelOutput.classification !== "irrelevant" &&
      output.purpose === "irrelevant_response_clarification")
  ) {
    issues.push(
      issue(
        fixture.caseId,
        "/modelOutput/recommendedFollowUp/purpose",
        "invalid_follow_up_semantics",
        "Follow-up kind, purpose, and classification must be compatible",
      ),
    );
  }
}

function validateExplicitZeroOutcomeFixture(
  fixture: Exclude<EvaluationFixture, ModelEvaluatedEvaluationFixture>,
  issues: EvaluationFixtureValidationIssue[],
): void {
  const expectedReason = fixture.category === "explicit_unknown" ? "unknown" : "skipped";
  const expectedCommand = fixture.category === "explicit_unknown" ? "mark_unknown" : "skip";
  if (
    fixture.answerMaterial.length !== 0 ||
    fixture.command !== expectedCommand ||
    fixture.expected.classification !== null ||
    fixture.expected.recommendedFollowUpGoal !== null ||
    fixture.expected.outcome.kind !== expectedReason ||
    fixture.expected.outcome.score !== 0 ||
    fixture.expected.outcome.zeroScoreReason !== expectedReason
  ) {
    issues.push(
      issue(
        fixture.caseId,
        "/expected",
        "invalid_explicit_zero_semantics",
        "Explicit unknown and skipped cases must bypass model evaluation with distinct zero outcomes",
      ),
    );
  }
}

function validateCategorySemantics(
  fixture: EvaluationFixture,
  issues: EvaluationFixtureValidationIssue[],
): void {
  const { classification, outcome, recommendedFollowUpGoal } = fixture.expected;
  let valid = true;
  switch (fixture.category) {
    case "correct":
      valid =
        fixture.execution === "model_evaluated" &&
        classification === "relevant" &&
        outcome.kind === "scored" &&
        outcome.score === 100 &&
        recommendedFollowUpGoal === null;
      break;
    case "partially_correct":
      valid =
        fixture.execution === "model_evaluated" &&
        classification === "relevant" &&
        outcome.kind === "scored" &&
        outcome.score > 0 &&
        outcome.score < 100;
      break;
    case "wholly_incorrect":
      valid =
        fixture.execution === "model_evaluated" &&
        classification === "relevant" &&
        outcome.kind === "incorrect" &&
        recommendedFollowUpGoal === null;
      break;
    case "explicit_unknown":
      valid = fixture.execution === "explicit_zero_outcome" && outcome.kind === "unknown";
      break;
    case "explicit_skipped":
      valid = fixture.execution === "explicit_zero_outcome" && outcome.kind === "skipped";
      break;
    case "irrelevant":
      valid =
        fixture.execution === "model_evaluated" &&
        classification === "irrelevant" &&
        outcome.kind === "irrelevant" &&
        recommendedFollowUpGoal === null &&
        fixture.usedFollowUpGoalIds.some((goalId) =>
          fixture.question.followUpGoals.some(
            (goal) => goal.kind === "clarification" && goal.id === goalId,
          ),
        );
      break;
    case "ambiguous":
      valid =
        fixture.execution === "model_evaluated" &&
        classification === "ambiguous" &&
        recommendedFollowUpGoal?.kind === "clarification" &&
        recommendedFollowUpGoal.purpose === "answer_clarification";
      break;
    case "prompt_injection":
      valid =
        fixture.execution === "model_evaluated" &&
        classification !== null &&
        outcome.score < 100 &&
        fixture.untrustedInputStrings.length > 0;
      break;
    default:
      valid = false;
  }
  if (!valid) {
    issues.push(
      issue(
        fixture.caseId,
        "/expected",
        "invalid_category_semantics",
        "Expected classification, outcome, score, and follow-up do not match the category",
      ),
    );
  }
}

function validateUntrustedInputStrings(
  fixture: EvaluationFixture,
  issues: EvaluationFixtureValidationIssue[],
): void {
  if (fixture.category !== "prompt_injection" && fixture.untrustedInputStrings.length > 0) {
    issues.push(
      issue(
        fixture.caseId,
        "/untrustedInputStrings",
        "unexpected_injection_string",
        "Only prompt-injection cases may declare untrusted input strings",
      ),
    );
  }

  const answerText = fixture.answerMaterial.map(({ text }) => text).join("\n");
  const trustedFixtureText = JSON.stringify({
    question: fixture.question,
    expected: fixture.expected,
    modelOutput: fixture.execution === "model_evaluated" ? fixture.modelOutput : null,
  });
  for (const [index, injectionString] of fixture.untrustedInputStrings.entries()) {
    requireSimplifiedChinese(
      fixture.caseId,
      `/untrustedInputStrings/${index}`,
      injectionString,
      issues,
    );
    if (!answerText.includes(injectionString) || trustedFixtureText.includes(injectionString)) {
      issues.push(
        issue(
          fixture.caseId,
          `/untrustedInputStrings/${index}`,
          "injection_not_untrusted",
          "Prompt-injection strings must exist only inside candidate answer material",
        ),
      );
    }
  }
}

function requireSimplifiedChinese(
  caseId: string,
  path: string,
  text: string,
  issues: EvaluationFixtureValidationIssue[],
): void {
  if (!isMeaningfulSimplifiedChineseText(text)) {
    issues.push(
      issue(
        caseId,
        path,
        "non_simplified_chinese",
        "Fixture text must use meaningful Simplified Chinese while preserving technical terms",
      ),
    );
  }
}

function sameOutcome(
  left: EvaluationFixture["expected"]["outcome"],
  right: EvaluationFixture["expected"]["outcome"],
): boolean {
  return (
    left.kind === right.kind &&
    left.score === right.score &&
    ("zeroScoreReason" in left ? left.zeroScoreReason : null) ===
      ("zeroScoreReason" in right ? right.zeroScoreReason : null)
  );
}

function issue(
  caseId: string | null,
  path: string,
  code: string,
  message: string,
): EvaluationFixtureValidationIssue {
  return { caseId, path, code, message };
}
