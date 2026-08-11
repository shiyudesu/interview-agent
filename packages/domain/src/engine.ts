import {
  InvalidBlueprintCoverageError,
  validateInterviewBlueprintCoverage,
} from "./blueprint-coverage.js";
import type {
  AbandonInterviewCommand,
  ContinueInterviewCommand,
  CreateInterviewCommand,
  EndInterviewEarlyCommand,
  ExpireInterviewCommand,
  InterviewCommand,
  MarkQuestionUnknownCommand,
  RecordQuestionClarificationCommand,
  RecordQuestionEvaluationCommand,
  RecordReportCommand,
  RecordSystemFollowUpCommand,
  RequestQuestionClarificationCommand,
  SkipQuestionCommand,
  SubmitAnswerCommand,
  SubmitSupplementCommand,
} from "./commands.js";
import type { InterviewEvent } from "./events.js";
import type { AccountId, InterviewId, MessageId, OperationId, ReportId } from "./identifiers.js";
import {
  type AnswerMaterial,
  type FollowUpKind,
  type FollowUpPurpose,
  type InterviewBlueprint,
  type InterviewPhase,
  type InterviewQuestionCount,
  type InterviewStatus,
  isSupportedQuestionCount,
  isTerminalInterviewStatus,
  type QuestionEvaluation,
  type QuestionEvaluationInput,
  type QuestionOutcome,
  type QuestionSnapshot,
  type ReportKind,
  type ResponseClassification,
} from "./interview.js";
import {
  createZeroQuestionOutcome,
  InvalidRubricAwardError,
  InvalidRubricError,
  scoreQuestion,
  validateRubric,
} from "./scoring.js";

const INACTIVITY_LIMIT_MS = 24 * 60 * 60 * 1000;

export class InterviewDomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InterviewDomainError";
  }
}

export class InterviewVersionConflictError extends InterviewDomainError {
  constructor(
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      "interview_version_conflict",
      `Expected interview version ${expectedVersion}, received ${actualVersion}`,
    );
    this.name = "InterviewVersionConflictError";
  }
}

export class InterviewIdMismatchError extends InterviewDomainError {
  constructor(
    readonly expectedInterviewId: InterviewId,
    readonly actualInterviewId: InterviewId,
  ) {
    super(
      "interview_id_mismatch",
      `Command interview ${actualInterviewId} does not match ${expectedInterviewId}`,
    );
    this.name = "InterviewIdMismatchError";
  }
}

export class InvalidInterviewBlueprintError extends InterviewDomainError {
  constructor(message: string) {
    super("invalid_interview_blueprint", message);
    this.name = "InvalidInterviewBlueprintError";
  }
}

export class InvalidInterviewCommandError extends InterviewDomainError {
  constructor(message: string) {
    super("invalid_interview_command", message);
    this.name = "InvalidInterviewCommandError";
  }
}

export interface QuestionClarification {
  readonly messageId: MessageId;
  readonly text: string;
  readonly requestedAt: Date;
  readonly recordedAt: Date;
}

export interface SystemFollowUp {
  readonly messageId: MessageId;
  readonly goalId: RecordSystemFollowUpCommand["goalId"];
  readonly kind: FollowUpKind;
  readonly purpose: FollowUpPurpose;
  readonly responseClassification: ResponseClassification;
  readonly text: string;
  readonly recordedAt: Date;
}

export interface InterviewQuestionState {
  readonly position: number;
  readonly answerMaterial: readonly AnswerMaterial[];
  readonly questionClarifications: readonly QuestionClarification[];
  readonly systemFollowUps: readonly SystemFollowUp[];
  readonly evaluation: QuestionEvaluation | null;
  readonly outcome: QuestionOutcome | null;
  readonly frozen: boolean;
}

export interface Interview {
  readonly id: InterviewId;
  readonly accountId: AccountId;
  readonly version: number;
  readonly status: InterviewStatus;
  readonly phase: InterviewPhase | null;
  readonly questionCount: InterviewQuestionCount;
  readonly blueprint: InterviewBlueprint;
  readonly currentQuestionPosition: number;
  readonly questions: readonly InterviewQuestionState[];
  readonly pendingOperation: PendingInterviewOperation | null;
  readonly pendingReportKind: ReportKind | null;
  readonly reportRequestedAt: Date | null;
  readonly reportId: ReportId | null;
  readonly createdAt: Date;
  readonly lastEffectiveActivityAt: Date;
}

export interface InterviewTransition {
  readonly kind: "transition";
  readonly interview: Interview;
  readonly events: readonly InterviewEvent[];
}

export interface PendingInterviewOperation {
  readonly operationId: OperationId;
  readonly operation: "answer_analysis" | "question_clarification";
  readonly questionPosition: number;
  readonly acceptedAt: Date;
  readonly previousPhase: "awaiting_response" | "awaiting_continue";
}

interface InterviewOperationPlanBase {
  readonly kind: "operation_plan";
  readonly interviewId: InterviewId;
  readonly operationId: OperationId;
  readonly questionPosition: number;
  readonly acceptedAt: Date;
  readonly interview: Interview;
}

export interface AnswerAnalysisPlan extends InterviewOperationPlanBase {
  readonly operation: "answer_analysis";
  readonly command: SubmitAnswerCommand | SubmitSupplementCommand;
  readonly material: AnswerMaterial;
}

export interface QuestionClarificationPlan extends InterviewOperationPlanBase {
  readonly operation: "question_clarification";
  readonly command: RequestQuestionClarificationCommand;
}

export type InterviewOperationPlan = AnswerAnalysisPlan | QuestionClarificationPlan;
export type InterviewCommandResult = InterviewTransition | InterviewOperationPlan;

type ImmediatelyHandledCommand =
  | CreateInterviewCommand
  | MarkQuestionUnknownCommand
  | SkipQuestionCommand
  | ContinueInterviewCommand
  | EndInterviewEarlyCommand
  | AbandonInterviewCommand
  | ExpireInterviewCommand
  | RecordReportCommand;

type PlannedCommand =
  | SubmitAnswerCommand
  | SubmitSupplementCommand
  | RequestQuestionClarificationCommand;

export type InitialInterviewCommand = ImmediatelyHandledCommand | PlannedCommand;

type AnswerCompletionCommand = RecordSystemFollowUpCommand | RecordQuestionEvaluationCommand;
export type InterviewOperationCompletion =
  | AnswerCompletionCommand
  | RecordQuestionClarificationCommand;

export function handleInterviewCommand(
  interview: Interview | null,
  command: InitialInterviewCommand,
): InterviewCommandResult {
  if (command.type === "create_interview") {
    if (interview !== null) {
      throw new InvalidInterviewCommandError("An interview already exists");
    }
    return createInterview(command);
  }

  if (interview === null) {
    throw new InvalidInterviewCommandError("Interview does not exist");
  }

  assertCommandIdentityAndDate(interview, command);
  if (
    interview.status === "active" &&
    command.type !== "expire_interview" &&
    isInterviewExpired(interview, command.occurredAt)
  ) {
    return expireInterview(interview, {
      type: "expire_interview",
      interviewId: interview.id,
      operationId: command.operationId,
      expectedVersion: interview.version,
      occurredAt: command.occurredAt,
    });
  }
  assertExpectedVersion(interview, command.expectedVersion);
  if (
    command.type === "record_report" &&
    interview.reportRequestedAt !== null &&
    command.occurredAt.getTime() < interview.reportRequestedAt.getTime()
  ) {
    throw new InvalidInterviewCommandError("Report completion cannot precede its request");
  }
  assertCommandTimeNotBeforeActivity(interview, command.occurredAt);
  if (interview.pendingOperation !== null && command.type !== "expire_interview") {
    throw new InvalidInterviewCommandError(
      "Interview processing must complete or be cancelled before another command",
    );
  }

  switch (command.type) {
    case "submit_answer":
      return planAnswerAnalysis(interview, command);
    case "submit_supplement":
      return planAnswerAnalysis(interview, command);
    case "request_question_clarification":
      return planQuestionClarification(interview, command);
    case "mark_question_unknown":
      return recordUnevaluatedOutcome(interview, command, "unknown");
    case "skip_question":
      return recordUnevaluatedOutcome(interview, command, "skipped");
    case "continue_interview":
      return continueInterview(interview, command);
    case "end_interview_early":
      return endInterviewEarly(interview, command);
    case "abandon_interview":
      return abandonInterview(interview, command);
    case "expire_interview":
      return expireInterview(interview, command);
    case "record_report":
      return recordReport(interview, command);
  }
}

export function completeInterviewOperation(
  interview: Interview,
  plan: InterviewOperationPlan,
  completion: InterviewOperationCompletion,
): InterviewTransition {
  assertPlanStillCurrent(interview, plan, completion);
  if (isInterviewExpired(interview, completion.occurredAt)) {
    return expireAcceptedOperation(interview, plan, completion);
  }

  if (plan.operation === "question_clarification") {
    if (completion.type !== "record_question_clarification") {
      throw new InvalidInterviewCommandError(
        "Question clarification plans require a clarification completion",
      );
    }
    return completeQuestionClarification(interview, plan, completion);
  }

  if (completion.type === "record_system_follow_up") {
    return completeWithSystemFollowUp(interview, plan, completion);
  }
  if (completion.type === "record_question_evaluation") {
    return completeWithQuestionEvaluation(interview, plan, completion);
  }

  throw new InvalidInterviewCommandError(
    "Answer analysis plans require a follow-up or evaluation completion",
  );
}

export function cancelInterviewOperation(
  interview: Interview,
  plan: InterviewOperationPlan,
): Interview {
  assertAcceptedOperation(interview, plan);
  const pendingOperation = requiredPendingOperation(interview);
  return {
    ...interview,
    phase: pendingOperation.previousPhase,
    pendingOperation: null,
  };
}

export function getInterviewProgress(interview: Interview): {
  readonly current: number;
  readonly total: InterviewQuestionCount;
} {
  return {
    current: interview.currentQuestionPosition,
    total: interview.questionCount,
  };
}

export function getCurrentQuestion(interview: Interview): QuestionSnapshot {
  return getBlueprintItem(interview, interview.currentQuestionPosition).question;
}

export function isInterviewExpired(interview: Interview, at: Date): boolean {
  assertValidDate(at, "expiry time");
  return (
    interview.status === "active" &&
    at.getTime() - interview.lastEffectiveActivityAt.getTime() > INACTIVITY_LIMIT_MS
  );
}

export function getInterviewExpiresAt(interview: Interview): Date {
  return new Date(interview.lastEffectiveActivityAt.getTime() + INACTIVITY_LIMIT_MS);
}

function createInterview(command: CreateInterviewCommand): InterviewTransition {
  if (command.expectedVersion !== 0) {
    throw new InterviewVersionConflictError(command.expectedVersion, 0);
  }
  assertValidDate(command.occurredAt, "creation time");
  if (!isSupportedQuestionCount(command.questionCount)) {
    throw new InvalidInterviewBlueprintError("Question count must be 5, 10, or 15");
  }

  const blueprint = validateAndFreezeBlueprint(command.blueprint, command.questionCount);
  const occurredAt = cloneDate(command.occurredAt);
  const interview: Interview = {
    id: command.interviewId,
    accountId: command.accountId,
    version: 1,
    status: "active",
    phase: "awaiting_response",
    questionCount: command.questionCount,
    blueprint,
    currentQuestionPosition: 1,
    questions: blueprint.questions.map((item) => ({
      position: item.position,
      answerMaterial: [],
      questionClarifications: [],
      systemFollowUps: [],
      evaluation: null,
      outcome: null,
      frozen: false,
    })),
    pendingOperation: null,
    pendingReportKind: null,
    reportRequestedAt: null,
    reportId: null,
    createdAt: occurredAt,
    lastEffectiveActivityAt: occurredAt,
  };

  return transition(interview, [
    {
      type: "interview_created",
      interviewId: command.interviewId,
      operationId: command.operationId,
      occurredAt,
      accountId: command.accountId,
      questionCount: command.questionCount,
      blueprint,
    },
  ]);
}

function planAnswerAnalysis(
  interview: Interview,
  command: SubmitAnswerCommand | SubmitSupplementCommand,
): AnswerAnalysisPlan {
  assertActive(interview);
  const expectedPhase =
    command.type === "submit_answer" ? "awaiting_response" : "awaiting_continue";
  assertPhase(interview, expectedPhase);
  assertNonEmptyText(command.text, command.type);
  assertValidDate(command.occurredAt, "answer time");

  const question = getCurrentQuestionState(interview);
  if (question.answerMaterial.some((material) => material.id === command.answerMaterialId)) {
    throw new InvalidInterviewCommandError("Answer material ID is already used");
  }

  const materialKind =
    command.type === "submit_supplement"
      ? "supplement"
      : hasUnansweredSystemFollowUp(question)
        ? "follow_up_answer"
        : "main_answer";
  const acceptedAt = cloneDate(command.occurredAt);
  const acceptedInterview = acceptOperation(
    interview,
    command.operationId,
    "answer_analysis",
    acceptedAt,
    expectedPhase,
  );

  return {
    kind: "operation_plan",
    operation: "answer_analysis",
    interviewId: interview.id,
    operationId: command.operationId,
    questionPosition: interview.currentQuestionPosition,
    acceptedAt,
    interview: acceptedInterview,
    command,
    material: {
      id: command.answerMaterialId,
      kind: materialKind,
      text: command.text,
      submittedAt: cloneDate(acceptedAt),
    },
  };
}

function planQuestionClarification(
  interview: Interview,
  command: RequestQuestionClarificationCommand,
): QuestionClarificationPlan {
  assertActive(interview);
  assertPhase(interview, "awaiting_response");
  assertValidDate(command.occurredAt, "clarification request time");
  const acceptedAt = cloneDate(command.occurredAt);

  return {
    kind: "operation_plan",
    operation: "question_clarification",
    interviewId: interview.id,
    operationId: command.operationId,
    questionPosition: interview.currentQuestionPosition,
    acceptedAt,
    interview: acceptOperation(
      interview,
      command.operationId,
      "question_clarification",
      acceptedAt,
      "awaiting_response",
    ),
    command,
  };
}

function acceptOperation(
  interview: Interview,
  operationId: OperationId,
  operation: PendingInterviewOperation["operation"],
  acceptedAt: Date,
  previousPhase: PendingInterviewOperation["previousPhase"],
): Interview {
  return advanceVersion({
    ...interview,
    phase: "processing",
    pendingOperation: {
      operationId,
      operation,
      questionPosition: interview.currentQuestionPosition,
      acceptedAt: cloneDate(acceptedAt),
      previousPhase,
    },
    lastEffectiveActivityAt: cloneDate(acceptedAt),
  });
}

function completeQuestionClarification(
  interview: Interview,
  plan: QuestionClarificationPlan,
  completion: RecordQuestionClarificationCommand,
): InterviewTransition {
  assertActive(interview);
  assertPhase(interview, "processing");
  assertNonEmptyText(completion.text, completion.type);
  assertValidDate(completion.occurredAt, "clarification completion time");

  const question = getCurrentQuestionState(interview);
  const updatedQuestion: InterviewQuestionState = {
    ...question,
    questionClarifications: [
      ...question.questionClarifications,
      {
        messageId: completion.messageId,
        text: completion.text,
        requestedAt: cloneDate(plan.acceptedAt),
        recordedAt: cloneDate(completion.occurredAt),
      },
    ],
  };
  const next = replaceCurrentQuestion(interview, updatedQuestion, {
    phase: "awaiting_response",
    pendingOperation: null,
  });

  return transition(next, [
    {
      type: "question_clarification_requested",
      interviewId: interview.id,
      operationId: plan.operationId,
      occurredAt: cloneDate(plan.acceptedAt),
      questionPosition: plan.questionPosition,
    },
    {
      type: "question_clarification_recorded",
      interviewId: interview.id,
      operationId: completion.operationId,
      occurredAt: cloneDate(completion.occurredAt),
      messageId: completion.messageId,
      questionPosition: plan.questionPosition,
      text: completion.text,
    },
  ]);
}

function completeWithSystemFollowUp(
  interview: Interview,
  plan: AnswerAnalysisPlan,
  completion: RecordSystemFollowUpCommand,
): InterviewTransition {
  assertActive(interview);
  assertPhase(interview, "processing");
  assertNonEmptyText(completion.text, completion.type);
  assertValidDate(completion.occurredAt, "follow-up completion time");

  const question = getCurrentQuestionState(interview);
  validateFollowUp(interview, question, completion);
  const hadEvaluation = question.evaluation !== null || question.outcome !== null;
  const updatedQuestion: InterviewQuestionState = {
    ...question,
    answerMaterial: [...question.answerMaterial, plan.material],
    systemFollowUps: [
      ...question.systemFollowUps,
      {
        messageId: completion.messageId,
        goalId: completion.goalId,
        kind: completion.kind,
        purpose: completion.purpose,
        responseClassification: completion.responseClassification,
        text: completion.text,
        recordedAt: cloneDate(completion.occurredAt),
      },
    ],
    evaluation: null,
    outcome: null,
  };
  const next = replaceCurrentQuestion(interview, updatedQuestion, {
    phase: "awaiting_response",
    pendingOperation: null,
  });
  const events: InterviewEvent[] = [
    answerMaterialEvent(interview, plan),
    ...(hadEvaluation
      ? [
          {
            type: "question_outcome_cleared" as const,
            interviewId: interview.id,
            operationId: plan.operationId,
            occurredAt: cloneDate(completion.occurredAt),
            questionPosition: plan.questionPosition,
          },
        ]
      : []),
    {
      type: "system_follow_up_recorded",
      interviewId: interview.id,
      operationId: completion.operationId,
      occurredAt: cloneDate(completion.occurredAt),
      messageId: completion.messageId,
      questionPosition: plan.questionPosition,
      goalId: completion.goalId,
      kind: completion.kind,
      purpose: completion.purpose,
      responseClassification: completion.responseClassification,
      text: completion.text,
    },
  ];

  return transition(next, events);
}

function completeWithQuestionEvaluation(
  interview: Interview,
  plan: AnswerAnalysisPlan,
  completion: RecordQuestionEvaluationCommand,
): InterviewTransition {
  assertActive(interview);
  assertPhase(interview, "processing");
  assertValidDate(completion.occurredAt, "evaluation completion time");

  const question = getCurrentQuestionState(interview);
  const answerMaterial = [...question.answerMaterial, plan.material];
  const evaluation = validateQuestionEvaluation(
    interview,
    question,
    answerMaterial,
    completion.evaluation,
  );
  const updatedQuestion: InterviewQuestionState = {
    ...question,
    answerMaterial,
    evaluation,
    outcome: evaluation.outcome,
  };
  const next = replaceCurrentQuestion(interview, updatedQuestion, {
    phase: "awaiting_continue",
    pendingOperation: null,
  });

  return transition(next, [
    answerMaterialEvent(interview, plan),
    {
      type: "question_evaluation_recorded",
      interviewId: interview.id,
      operationId: completion.operationId,
      occurredAt: cloneDate(completion.occurredAt),
      questionPosition: plan.questionPosition,
      evaluation,
    },
  ]);
}

function recordUnevaluatedOutcome(
  interview: Interview,
  command: MarkQuestionUnknownCommand | SkipQuestionCommand,
  kind: "unknown" | "skipped",
): InterviewTransition {
  assertActive(interview);
  assertPhase(interview, "awaiting_response");
  assertValidDate(command.occurredAt, "outcome time");

  const outcome = createZeroQuestionOutcome(kind);
  const question = getCurrentQuestionState(interview);
  const updatedQuestion: InterviewQuestionState = {
    ...question,
    evaluation: null,
    outcome,
  };
  const next = advanceVersion(
    replaceCurrentQuestion(interview, updatedQuestion, {
      phase: "awaiting_continue",
      lastEffectiveActivityAt: cloneDate(command.occurredAt),
    }),
  );

  return transition(next, [
    {
      type: "unevaluated_question_outcome_recorded",
      interviewId: interview.id,
      operationId: command.operationId,
      occurredAt: cloneDate(command.occurredAt),
      questionPosition: interview.currentQuestionPosition,
      outcome,
    },
  ]);
}

function continueInterview(
  interview: Interview,
  command: ContinueInterviewCommand,
): InterviewTransition {
  assertActive(interview);
  assertPhase(interview, "awaiting_continue");
  assertValidDate(command.occurredAt, "continue time");

  const question = getCurrentQuestionState(interview);
  if (question.outcome === null) {
    throw new InvalidInterviewCommandError("Current question has no outcome to freeze");
  }
  const frozenQuestion = { ...question, frozen: true };
  const isFinalQuestion = interview.currentQuestionPosition === interview.questionCount;
  const base = replaceCurrentQuestion(interview, frozenQuestion, {
    currentQuestionPosition: isFinalQuestion
      ? interview.currentQuestionPosition
      : interview.currentQuestionPosition + 1,
    status: isFinalQuestion ? "report_pending" : "active",
    phase: isFinalQuestion ? null : "awaiting_response",
    pendingOperation: null,
    pendingReportKind: isFinalQuestion ? "complete" : null,
    reportRequestedAt: isFinalQuestion ? cloneDate(command.occurredAt) : null,
    lastEffectiveActivityAt: cloneDate(command.occurredAt),
  });
  const next = advanceVersion(base);
  const events: InterviewEvent[] = [
    {
      type: "question_frozen",
      interviewId: interview.id,
      operationId: command.operationId,
      occurredAt: cloneDate(command.occurredAt),
      questionPosition: interview.currentQuestionPosition,
    },
  ];
  if (isFinalQuestion) {
    events.push({
      type: "report_requested",
      interviewId: interview.id,
      operationId: command.operationId,
      occurredAt: cloneDate(command.occurredAt),
      reportKind: "complete",
    });
  }

  return transition(next, events);
}

function endInterviewEarly(
  interview: Interview,
  command: EndInterviewEarlyCommand,
): InterviewTransition {
  assertActive(interview);
  assertValidDate(command.occurredAt, "early-end time");
  if (!interview.questions.some((question) => question.outcome !== null)) {
    throw new InvalidInterviewCommandError(
      "An interview needs at least one question outcome before ending early",
    );
  }

  const next = advanceVersion({
    ...interview,
    status: "report_pending",
    phase: null,
    pendingOperation: null,
    pendingReportKind: "incomplete",
    reportRequestedAt: cloneDate(command.occurredAt),
    lastEffectiveActivityAt: cloneDate(command.occurredAt),
  });
  return transition(next, [
    {
      type: "report_requested",
      interviewId: interview.id,
      operationId: command.operationId,
      occurredAt: cloneDate(command.occurredAt),
      reportKind: "incomplete",
    },
  ]);
}

function abandonInterview(
  interview: Interview,
  command: AbandonInterviewCommand,
): InterviewTransition {
  assertActive(interview);
  assertValidDate(command.occurredAt, "abandonment time");
  return transition(
    advanceVersion({
      ...interview,
      status: "abandoned",
      phase: null,
      pendingOperation: null,
      pendingReportKind: null,
      reportRequestedAt: null,
    }),
    [
      {
        type: "interview_abandoned",
        interviewId: interview.id,
        operationId: command.operationId,
        occurredAt: cloneDate(command.occurredAt),
        reason: "user",
      },
    ],
  );
}

function expireInterview(
  interview: Interview,
  command: ExpireInterviewCommand,
): InterviewTransition {
  assertActive(interview);
  assertValidDate(command.occurredAt, "expiry time");
  if (!isInterviewExpired(interview, command.occurredAt)) {
    throw new InvalidInterviewCommandError(
      "Interview expires only after more than 24 hours of inactivity",
    );
  }

  return transition(
    advanceVersion({
      ...interview,
      status: "abandoned",
      phase: null,
      pendingOperation: null,
      pendingReportKind: null,
      reportRequestedAt: null,
    }),
    [
      {
        type: "interview_abandoned",
        interviewId: interview.id,
        operationId: command.operationId,
        occurredAt: cloneDate(command.occurredAt),
        reason: "expired",
      },
    ],
  );
}

function recordReport(interview: Interview, command: RecordReportCommand): InterviewTransition {
  if (interview.status !== "report_pending") {
    if (isTerminalInterviewStatus(interview.status)) {
      throw new InvalidInterviewCommandError("Terminal interviews are read-only");
    }
    throw new InvalidInterviewCommandError("Interview is not awaiting a report");
  }
  assertValidDate(command.occurredAt, "report completion time");
  if (interview.pendingReportKind !== command.reportKind) {
    throw new InvalidInterviewCommandError(
      `Expected a ${interview.pendingReportKind ?? "missing"} report`,
    );
  }
  if (
    interview.reportRequestedAt === null ||
    command.occurredAt.getTime() < interview.reportRequestedAt.getTime()
  ) {
    throw new InvalidInterviewCommandError("Report completion cannot precede its request");
  }

  const next = advanceVersion({
    ...interview,
    status: command.reportKind === "complete" ? "completed" : "early_ended",
    pendingOperation: null,
    pendingReportKind: null,
    reportId: command.reportId,
  });
  return transition(next, [
    {
      type: "report_stored",
      interviewId: interview.id,
      operationId: command.operationId,
      occurredAt: cloneDate(command.occurredAt),
      reportId: command.reportId,
      reportKind: command.reportKind,
    },
  ]);
}

function validateAndFreezeBlueprint(
  blueprint: InterviewBlueprint,
  questionCount: InterviewQuestionCount,
): InterviewBlueprint {
  assertNonEmptyText(blueprint.selectionSeed, "selection seed");
  if (blueprint.questions.length !== questionCount) {
    throw new InvalidInterviewBlueprintError(
      `Blueprint must contain exactly ${questionCount} questions`,
    );
  }

  const questionKeys = new Set<string>();
  const frozenQuestions = blueprint.questions.map((item, index) => {
    const expectedPosition = index + 1;
    if (item.position !== expectedPosition) {
      throw new InvalidInterviewBlueprintError(
        `Blueprint position ${item.position} must be ${expectedPosition}`,
      );
    }
    validateQuestionSnapshot(item.question);
    const key = `${item.question.questionId}:${item.question.questionVersion}`;
    if (questionKeys.has(key)) {
      throw new InvalidInterviewBlueprintError(`Duplicate blueprint question ${key}`);
    }
    questionKeys.add(key);

    const question = Object.freeze({
      ...item.question,
      rubric: Object.freeze(
        item.question.rubric.map((rubricItem) => Object.freeze({ ...rubricItem })),
      ),
      followUpGoals: Object.freeze(
        item.question.followUpGoals.map((goal) => Object.freeze({ ...goal })),
      ),
    });
    return Object.freeze({ position: item.position, question });
  });

  try {
    validateInterviewBlueprintCoverage({
      questionCount,
      questions: frozenQuestions,
      unassessedDomain: blueprint.unassessedDomain,
    });
  } catch (error) {
    if (error instanceof InvalidBlueprintCoverageError) {
      throw new InvalidInterviewBlueprintError(error.reason);
    }
    throw error;
  }

  return Object.freeze({
    selectionSeed: blueprint.selectionSeed,
    unassessedDomain: blueprint.unassessedDomain,
    questions: Object.freeze(frozenQuestions),
  });
}

function validateQuestionSnapshot(question: QuestionSnapshot): void {
  if (!Number.isInteger(question.questionVersion) || question.questionVersion < 1) {
    throw new InvalidInterviewBlueprintError("Question version must be a positive integer");
  }
  assertNonEmptyBlueprintText(question.sourceWording, "source wording");
  assertNonEmptyBlueprintText(question.displayedWording, "displayed wording");
  assertNonEmptyBlueprintText(question.knowledgeExplanation, "knowledge explanation");
  for (const item of question.rubric) {
    assertNonEmptyBlueprintText(item.description, "Rubric description");
  }
  try {
    validateRubric(question.rubric);
  } catch (error) {
    if (error instanceof InvalidRubricError) {
      throw new InvalidInterviewBlueprintError(error.message);
    }
    throw error;
  }

  const goalIds = new Set<string>();
  let hasClarificationGoal = false;
  for (const goal of question.followUpGoals) {
    if (goalIds.has(goal.id)) {
      throw new InvalidInterviewBlueprintError(`Duplicate follow-up goal ${goal.id}`);
    }
    goalIds.add(goal.id);
    assertNonEmptyBlueprintText(goal.goal, "follow-up goal");
    hasClarificationGoal ||= goal.kind === "clarification";
  }
  if (!hasClarificationGoal) {
    throw new InvalidInterviewBlueprintError(
      "Each question requires a predefined clarification goal",
    );
  }
}

function validateFollowUp(
  interview: Interview,
  question: InterviewQuestionState,
  completion: RecordSystemFollowUpCommand,
): void {
  const snapshot = getCurrentQuestion(interview);
  const goal = snapshot.followUpGoals.find((candidate) => candidate.id === completion.goalId);
  if (goal === undefined) {
    throw new InvalidInterviewCommandError("Follow-up must reference a predefined goal");
  }
  if (goal.kind !== completion.kind) {
    throw new InvalidInterviewCommandError("Follow-up kind must match its predefined goal");
  }
  if (question.systemFollowUps.some((followUp) => followUp.goalId === completion.goalId)) {
    throw new InvalidInterviewCommandError("Follow-up goal has already been used");
  }
  if (question.systemFollowUps.some((followUp) => followUp.kind === completion.kind)) {
    throw new InvalidInterviewCommandError(`A ${completion.kind} follow-up has already been used`);
  }

  const expectedKind = purposeKind(completion.purpose);
  if (expectedKind !== completion.kind) {
    throw new InvalidInterviewCommandError("Follow-up purpose does not match its kind");
  }
  const isIrrelevantPurpose = completion.purpose === "irrelevant_response_clarification";
  if (isIrrelevantPurpose !== (completion.responseClassification === "irrelevant")) {
    throw new InvalidInterviewCommandError(
      "Irrelevant responses require the dedicated clarification purpose",
    );
  }
}

function validateQuestionEvaluation(
  interview: Interview,
  question: InterviewQuestionState,
  answerMaterial: readonly AnswerMaterial[],
  evaluation: QuestionEvaluationInput,
): QuestionEvaluation {
  const snapshot = getCurrentQuestion(interview);
  const materialIds = new Set(answerMaterial.map((material) => material.id));
  if (evaluation.classification === "irrelevant") {
    if (!question.systemFollowUps.some((followUp) => followUp.kind === "clarification")) {
      throw new InvalidInterviewCommandError(
        "An irrelevant outcome requires a clarification opportunity first",
      );
    }
  }

  try {
    return scoreQuestion({
      rubric: snapshot.rubric,
      evaluation,
      validEvidenceMaterialIds: materialIds,
    });
  } catch (error) {
    if (error instanceof InvalidRubricError || error instanceof InvalidRubricAwardError) {
      throw new InvalidInterviewCommandError(error.message);
    }
    throw error;
  }
}

function assertPlanStillCurrent(
  interview: Interview,
  plan: InterviewOperationPlan,
  completion: InterviewOperationCompletion,
): void {
  assertAcceptedOperation(interview, plan);
  assertCommandIdentityAndDate(interview, completion);
  assertExpectedVersion(interview, completion.expectedVersion);
  assertCommandTimeNotBeforeActivity(interview, completion.occurredAt);
  if (plan.operationId !== completion.operationId) {
    throw new InvalidInterviewCommandError("Completion operation does not match its plan");
  }
  if (completion.occurredAt.getTime() < plan.acceptedAt.getTime()) {
    throw new InvalidInterviewCommandError("Operation completion cannot precede acceptance");
  }
}

function assertAcceptedOperation(interview: Interview, plan: InterviewOperationPlan): void {
  if (plan.interviewId !== interview.id) {
    throw new InterviewIdMismatchError(interview.id, plan.interviewId);
  }
  if (plan.interview.id !== interview.id) {
    throw new InterviewIdMismatchError(interview.id, plan.interview.id);
  }
  if (plan.interview.version !== interview.version) {
    throw new InterviewVersionConflictError(plan.interview.version, interview.version);
  }
  if (
    plan.interview.status !== "active" ||
    plan.interview.phase !== "processing" ||
    plan.interview.lastEffectiveActivityAt.getTime() !== plan.acceptedAt.getTime() ||
    interview.lastEffectiveActivityAt.getTime() !== plan.acceptedAt.getTime()
  ) {
    throw new InvalidInterviewCommandError("Operation plan does not contain its accepted state");
  }
  assertActive(interview);
  assertPhase(interview, "processing");

  const pendingOperation = requiredPendingOperation(interview);
  const plannedPendingOperation = requiredPendingOperation(plan.interview);
  const expectedPreviousPhase =
    plan.operation === "question_clarification" || plan.command.type === "submit_answer"
      ? "awaiting_response"
      : "awaiting_continue";
  if (
    pendingOperation.operationId !== plan.operationId ||
    pendingOperation.operation !== plan.operation ||
    pendingOperation.questionPosition !== plan.questionPosition ||
    pendingOperation.acceptedAt.getTime() !== plan.acceptedAt.getTime() ||
    plannedPendingOperation.operationId !== pendingOperation.operationId ||
    plannedPendingOperation.operation !== pendingOperation.operation ||
    plannedPendingOperation.questionPosition !== pendingOperation.questionPosition ||
    plannedPendingOperation.acceptedAt.getTime() !== pendingOperation.acceptedAt.getTime() ||
    plannedPendingOperation.previousPhase !== pendingOperation.previousPhase ||
    pendingOperation.previousPhase !== expectedPreviousPhase
  ) {
    throw new InvalidInterviewCommandError("Interview does not contain the accepted Operation");
  }
  if (plan.questionPosition !== interview.currentQuestionPosition) {
    throw new InvalidInterviewCommandError("The planned question is no longer current");
  }
}

function requiredPendingOperation(interview: Interview): PendingInterviewOperation {
  if (interview.pendingOperation === null) {
    throw new InvalidInterviewCommandError("Interview has no pending Operation");
  }
  return interview.pendingOperation;
}

function expireAcceptedOperation(
  interview: Interview,
  plan: InterviewOperationPlan,
  completion: InterviewOperationCompletion,
): InterviewTransition {
  return transition(
    {
      ...interview,
      status: "abandoned",
      phase: null,
      pendingOperation: null,
      pendingReportKind: null,
      reportRequestedAt: null,
    },
    [
      {
        type: "interview_abandoned",
        interviewId: interview.id,
        operationId: plan.operationId,
        occurredAt: cloneDate(completion.occurredAt),
        reason: "expired",
      },
    ],
  );
}

function assertCommandIdentityAndDate(
  interview: Interview,
  command: Pick<InterviewCommand, "interviewId" | "expectedVersion" | "occurredAt">,
): void {
  if (command.interviewId !== interview.id) {
    throw new InterviewIdMismatchError(interview.id, command.interviewId);
  }
  assertValidDate(command.occurredAt, "command time");
}

function assertCommandTimeNotBeforeActivity(interview: Interview, occurredAt: Date): void {
  if (occurredAt.getTime() < interview.lastEffectiveActivityAt.getTime()) {
    throw new InvalidInterviewCommandError(
      "Command time cannot precede the last effective activity",
    );
  }
}

function assertExpectedVersion(interview: Interview, expectedVersion: number): void {
  if (expectedVersion !== interview.version) {
    throw new InterviewVersionConflictError(expectedVersion, interview.version);
  }
}

function assertActive(interview: Interview): void {
  if (interview.status === "report_pending") {
    throw new InvalidInterviewCommandError(
      "Report-pending interviews accept only matching report completion",
    );
  }
  if (isTerminalInterviewStatus(interview.status)) {
    throw new InvalidInterviewCommandError("Terminal interviews are read-only");
  }
  if (interview.status !== "active") {
    throw new InvalidInterviewCommandError("Interview is not active");
  }
}

function assertPhase(interview: Interview, phase: InterviewPhase): void {
  if (interview.phase !== phase) {
    throw new InvalidInterviewCommandError(
      `Interview phase ${interview.phase ?? "none"} does not accept this command`,
    );
  }
}

function assertNonEmptyText(text: string, field: string): void {
  if (text.trim().length === 0) {
    throw new InvalidInterviewCommandError(`${field} cannot be empty`);
  }
}

function assertNonEmptyBlueprintText(text: string, field: string): void {
  if (text.trim().length === 0) {
    throw new InvalidInterviewBlueprintError(`${field} cannot be empty`);
  }
}

function assertValidDate(value: Date, field: string): void {
  if (!Number.isFinite(value.getTime())) {
    throw new InvalidInterviewCommandError(`${field} must be a valid date`);
  }
}

function purposeKind(purpose: FollowUpPurpose): FollowUpKind {
  return purpose === "depth" ? "depth" : "clarification";
}

function hasUnansweredSystemFollowUp(question: InterviewQuestionState): boolean {
  const followUpAnswers = question.answerMaterial.filter(
    (material) => material.kind === "follow_up_answer",
  ).length;
  return question.systemFollowUps.length > followUpAnswers;
}

function getCurrentQuestionState(interview: Interview): InterviewQuestionState {
  const question = interview.questions[interview.currentQuestionPosition - 1];
  if (question === undefined || question.position !== interview.currentQuestionPosition) {
    throw new InvalidInterviewCommandError("Current question state is invalid");
  }
  return question;
}

function getBlueprintItem(
  interview: Interview,
  position: number,
): InterviewBlueprint["questions"][number] {
  const item = interview.blueprint.questions[position - 1];
  if (item === undefined || item.position !== position) {
    throw new InvalidInterviewCommandError("Current blueprint position is invalid");
  }
  return item;
}

function replaceCurrentQuestion(
  interview: Interview,
  question: InterviewQuestionState,
  changes: Partial<Interview>,
): Interview {
  return {
    ...interview,
    ...changes,
    questions: interview.questions.map((candidate) =>
      candidate.position === question.position ? question : candidate,
    ),
  };
}

function answerMaterialEvent(interview: Interview, plan: AnswerAnalysisPlan): InterviewEvent {
  return {
    type: "answer_material_submitted",
    interviewId: interview.id,
    operationId: plan.operationId,
    occurredAt: cloneDate(plan.acceptedAt),
    answerMaterialId: plan.material.id,
    materialKind: plan.material.kind,
    questionPosition: plan.questionPosition,
    text: plan.material.text,
  };
}

function advanceVersion(interview: Interview): Interview {
  return { ...interview, version: interview.version + 1 };
}

function transition(interview: Interview, events: readonly InterviewEvent[]): InterviewTransition {
  return { kind: "transition", interview, events };
}

function cloneDate(value: Date): Date {
  return new Date(value.getTime());
}
