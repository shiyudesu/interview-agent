import type {
  Interview,
  InterviewEvent,
  InterviewQuestionState,
  PendingInterviewOperation,
} from "@interview-agent/domain";

import { RepositoryCorruptionError, RepositoryImmutableConflictError } from "./errors.js";
import type { InterviewSave } from "./types.js";

export function validateInterviewSave(change: InterviewSave): void {
  assertImmutableIdentity(change);
  assertEventIdentity(change);

  if (change.events.length === 0) {
    validateEventlessTransition(change.previous, change.current);
    assertPersistencePayloads(change, false, false);
    return;
  }

  const eventTypes = change.events.map((event) => event.type);
  if (
    sameSequence(eventTypes, [
      "question_clarification_requested",
      "question_clarification_recorded",
    ])
  ) {
    validateClarificationCompletion(change.previous, change.current, change.events);
    assertPersistencePayloads(change, false, false);
    return;
  }
  if (
    sameSequence(eventTypes, ["answer_material_submitted", "system_follow_up_recorded"]) ||
    sameSequence(eventTypes, [
      "answer_material_submitted",
      "question_outcome_cleared",
      "system_follow_up_recorded",
    ])
  ) {
    validateFollowUpCompletion(change.previous, change.current, change.events);
    assertPersistencePayloads(change, false, false);
    return;
  }
  if (sameSequence(eventTypes, ["answer_material_submitted", "question_evaluation_recorded"])) {
    validateEvaluationCompletion(change.previous, change.current, change.events);
    assertPersistencePayloads(change, true, false);
    return;
  }
  if (sameSequence(eventTypes, ["unevaluated_question_outcome_recorded"])) {
    validateUnevaluatedOutcome(change.previous, change.current, change.events[0]);
    assertPersistencePayloads(change, false, false);
    return;
  }
  if (
    sameSequence(eventTypes, ["question_frozen"]) ||
    sameSequence(eventTypes, ["question_frozen", "report_requested"])
  ) {
    validateContinue(change.previous, change.current, change.events);
    assertPersistencePayloads(change, false, false);
    return;
  }
  if (sameSequence(eventTypes, ["report_requested"])) {
    validateEarlyEnd(change.previous, change.current, change.events[0]);
    assertPersistencePayloads(change, false, false);
    return;
  }
  if (sameSequence(eventTypes, ["report_stored"])) {
    validateReportStored(change.previous, change.current, change.events[0]);
    assertPersistencePayloads(change, false, true);
    return;
  }
  if (sameSequence(eventTypes, ["interview_abandoned"])) {
    validateAbandonment(change.previous, change.current, change.events[0]);
    assertPersistencePayloads(change, false, false);
    return;
  }

  reject(
    change.previous.id,
    `unsupported or non-canonical event sequence: ${eventTypes.join(", ")}`,
  );
}

function validateEventlessTransition(previous: Interview, current: Interview): void {
  if (
    previous.status === "report_pending" &&
    current.status === "report_pending" &&
    previous.phase === null &&
    current.phase === null &&
    previous.pendingOperation === null &&
    current.pendingOperation === null &&
    previous.pendingReportKind !== null &&
    previous.reportRequestedAt !== null &&
    previous.reportId === null &&
    current.lastEffectiveActivityAt.getTime() > previous.lastEffectiveActivityAt.getTime()
  ) {
    assertAggregateEquals(
      current,
      {
        ...previous,
        lastEffectiveActivityAt: cloneDate(current.lastEffectiveActivityAt),
      },
      "report retry activity refresh",
    );
    return;
  }

  if (previous.pendingOperation === null && current.pendingOperation !== null) {
    const pending = current.pendingOperation;
    const isInitialAcceptance = current.version === previous.version + 1;
    const isRetryAcceptance = current.version === previous.version;
    if (
      (!isInitialAcceptance && !isRetryAcceptance) ||
      previous.status !== "active" ||
      previous.phase !== pending.previousPhase ||
      (pending.previousPhase !== "awaiting_response" &&
        pending.previousPhase !== "awaiting_continue") ||
      pending.questionPosition !== previous.currentQuestionPosition ||
      pending.acceptedAt.getTime() < previous.lastEffectiveActivityAt.getTime() ||
      (pending.operation === "question_clarification"
        ? pending.previousPhase !== "awaiting_response"
        : pending.previousPhase !== "awaiting_response" &&
          pending.previousPhase !== "awaiting_continue")
    ) {
      reject(previous.id, "accepted pending Operation does not match the previous lifecycle");
    }
    assertAggregateEquals(
      current,
      {
        ...previous,
        version: isInitialAcceptance ? previous.version + 1 : previous.version,
        phase: "processing",
        pendingOperation: clonePending(pending),
        lastEffectiveActivityAt: cloneDate(pending.acceptedAt),
      },
      "accepted pending Operation",
    );
    return;
  }

  if (previous.pendingOperation !== null && current.pendingOperation !== null) {
    const previousPending = previous.pendingOperation;
    const currentPending = current.pendingOperation;
    if (
      previous.status !== "active" ||
      previous.phase !== "processing" ||
      currentPending.operationId !== previousPending.operationId ||
      currentPending.operation !== previousPending.operation ||
      currentPending.questionPosition !== previousPending.questionPosition ||
      currentPending.previousPhase !== previousPending.previousPhase ||
      currentPending.acceptedAt.getTime() < previousPending.acceptedAt.getTime()
    ) {
      reject(previous.id, "refreshed pending Operation does not match the active lease");
    }
    assertAggregateEquals(
      current,
      {
        ...previous,
        pendingOperation: clonePending(currentPending),
        lastEffectiveActivityAt: cloneDate(currentPending.acceptedAt),
      },
      "refreshed pending Operation",
    );
    return;
  }

  if (previous.pendingOperation !== null && current.pendingOperation === null) {
    assertAggregateEquals(
      current,
      {
        ...previous,
        phase: previous.pendingOperation.previousPhase,
        pendingOperation: null,
      },
      "cancelled pending Operation",
    );
    return;
  }

  reject(previous.id, "eventless save is neither Operation acceptance nor cancellation");
}

function validateClarificationCompletion(
  previous: Interview,
  current: Interview,
  events: readonly InterviewEvent[],
): void {
  const request = events[0];
  const recorded = events[1];
  if (
    request?.type !== "question_clarification_requested" ||
    recorded?.type !== "question_clarification_recorded"
  ) {
    reject(previous.id, "clarification events are malformed");
  }
  const pending = requirePending(previous, "question_clarification");
  assertSameOperation(previous.id, pending, [request, recorded]);
  if (
    request.questionPosition !== pending.questionPosition ||
    recorded.questionPosition !== pending.questionPosition ||
    request.occurredAt.getTime() > pending.acceptedAt.getTime() ||
    recorded.occurredAt.getTime() < request.occurredAt.getTime()
  ) {
    reject(previous.id, "clarification event timing or question position is mismatched");
  }
  const question = getQuestion(previous, pending.questionPosition);
  const expectedQuestion: InterviewQuestionState = {
    ...question,
    questionClarifications: [
      ...question.questionClarifications,
      {
        messageId: recorded.messageId,
        text: recorded.text,
        requestedAt: cloneDate(request.occurredAt),
        recordedAt: cloneDate(recorded.occurredAt),
      },
    ],
  };
  assertAggregateEquals(
    current,
    replaceQuestion(previous, expectedQuestion, {
      phase: "awaiting_response",
      pendingOperation: null,
    }),
    "clarification completion",
  );
}

function validateFollowUpCompletion(
  previous: Interview,
  current: Interview,
  events: readonly InterviewEvent[],
): void {
  const answer = events[0];
  const clear = events.length === 3 ? events[1] : undefined;
  const followUp = events.at(-1);
  if (
    answer?.type !== "answer_material_submitted" ||
    (clear !== undefined && clear.type !== "question_outcome_cleared") ||
    followUp?.type !== "system_follow_up_recorded"
  ) {
    reject(previous.id, "follow-up events are malformed");
  }
  const pending = requirePending(previous, "answer_analysis");
  assertSameOperation(previous.id, pending, events);
  assertAnswerEvent(previous, pending, answer);
  if (
    followUp.questionPosition !== pending.questionPosition ||
    followUp.occurredAt.getTime() < pending.acceptedAt.getTime()
  ) {
    reject(previous.id, "follow-up event timing or question position is mismatched");
  }
  const question = getQuestion(previous, pending.questionPosition);
  const hadOutcome = question.evaluation !== null || question.outcome !== null;
  if (
    hadOutcome !== (clear !== undefined) ||
    (clear !== undefined && clear.questionPosition !== pending.questionPosition)
  ) {
    reject(previous.id, "question outcome clear event does not match the aggregate diff");
  }
  const expectedQuestion: InterviewQuestionState = {
    ...question,
    answerMaterial: [...question.answerMaterial, answerMaterialFrom(answer)],
    systemFollowUps: [
      ...question.systemFollowUps,
      {
        messageId: followUp.messageId,
        goalId: followUp.goalId,
        kind: followUp.kind,
        purpose: followUp.purpose,
        responseClassification: followUp.responseClassification,
        text: followUp.text,
        recordedAt: cloneDate(followUp.occurredAt),
      },
    ],
    evaluation: null,
    outcome: null,
  };
  assertAggregateEquals(
    current,
    replaceQuestion(previous, expectedQuestion, {
      phase: "awaiting_response",
      pendingOperation: null,
    }),
    "system follow-up completion",
  );
}

function validateEvaluationCompletion(
  previous: Interview,
  current: Interview,
  events: readonly InterviewEvent[],
): void {
  const answer = events[0];
  const evaluation = events[1];
  if (
    answer?.type !== "answer_material_submitted" ||
    evaluation?.type !== "question_evaluation_recorded"
  ) {
    reject(previous.id, "evaluation events are malformed");
  }
  const pending = requirePending(previous, "answer_analysis");
  assertSameOperation(previous.id, pending, events);
  assertAnswerEvent(previous, pending, answer);
  if (
    evaluation.questionPosition !== pending.questionPosition ||
    evaluation.occurredAt.getTime() < pending.acceptedAt.getTime()
  ) {
    reject(previous.id, "evaluation event timing or question position is mismatched");
  }
  const question = getQuestion(previous, pending.questionPosition);
  const expectedQuestion: InterviewQuestionState = {
    ...question,
    answerMaterial: [...question.answerMaterial, answerMaterialFrom(answer)],
    evaluation: evaluation.evaluation,
    outcome: evaluation.evaluation.outcome,
  };
  assertAggregateEquals(
    current,
    replaceQuestion(previous, expectedQuestion, {
      phase: "awaiting_continue",
      pendingOperation: null,
    }),
    "question evaluation completion",
  );
}

function validateUnevaluatedOutcome(
  previous: Interview,
  current: Interview,
  event: InterviewEvent | undefined,
): void {
  if (
    event?.type !== "unevaluated_question_outcome_recorded" ||
    previous.status !== "active" ||
    previous.phase !== "awaiting_response" ||
    previous.pendingOperation !== null ||
    event.questionPosition !== previous.currentQuestionPosition
  ) {
    reject(previous.id, "unevaluated outcome event does not match the active question");
  }
  const question = getQuestion(previous, event.questionPosition);
  const expectedQuestion: InterviewQuestionState = {
    ...question,
    evaluation: null,
    outcome: event.outcome,
  };
  assertAggregateEquals(
    current,
    {
      ...replaceQuestion(previous, expectedQuestion, {
        phase: "awaiting_continue",
        lastEffectiveActivityAt: cloneDate(event.occurredAt),
      }),
      version: previous.version + 1,
    },
    "unevaluated question outcome",
  );
}

function validateContinue(
  previous: Interview,
  current: Interview,
  events: readonly InterviewEvent[],
): void {
  const frozen = events[0];
  const reportRequested = events[1];
  if (
    frozen?.type !== "question_frozen" ||
    previous.status !== "active" ||
    previous.phase !== "awaiting_continue" ||
    previous.pendingOperation !== null ||
    frozen.questionPosition !== previous.currentQuestionPosition
  ) {
    reject(previous.id, "question freeze event does not match the active question");
  }
  const question = getQuestion(previous, frozen.questionPosition);
  if (question.outcome === null || question.frozen) {
    reject(previous.id, "question freeze requires an unfrozen outcome");
  }
  const finalQuestion = previous.currentQuestionPosition === previous.questionCount;
  if (
    finalQuestion !== (reportRequested?.type === "report_requested") ||
    (reportRequested?.type === "report_requested" &&
      (reportRequested.reportKind !== "complete" ||
        reportRequested.operationId !== frozen.operationId ||
        reportRequested.occurredAt.getTime() !== frozen.occurredAt.getTime()))
  ) {
    reject(previous.id, "complete report request does not match the final question freeze");
  }
  const expected = replaceQuestion(
    previous,
    { ...question, frozen: true },
    {
      currentQuestionPosition: finalQuestion
        ? previous.currentQuestionPosition
        : previous.currentQuestionPosition + 1,
      status: finalQuestion ? "report_pending" : "active",
      phase: finalQuestion ? null : "awaiting_response",
      pendingOperation: null,
      pendingReportKind: finalQuestion ? "complete" : null,
      reportRequestedAt: finalQuestion ? cloneDate(frozen.occurredAt) : null,
      lastEffectiveActivityAt: cloneDate(frozen.occurredAt),
    },
  );
  assertAggregateEquals(
    current,
    { ...expected, version: previous.version + 1 },
    "question continuation",
  );
}

function validateEarlyEnd(
  previous: Interview,
  current: Interview,
  event: InterviewEvent | undefined,
): void {
  if (
    event?.type !== "report_requested" ||
    event.reportKind !== "incomplete" ||
    previous.status !== "active" ||
    previous.pendingOperation !== null ||
    !previous.questions.some((question) => question.outcome !== null)
  ) {
    reject(previous.id, "incomplete report request does not match an early-end transition");
  }
  assertAggregateEquals(
    current,
    {
      ...previous,
      version: previous.version + 1,
      status: "report_pending",
      phase: null,
      pendingOperation: null,
      pendingReportKind: "incomplete",
      reportRequestedAt: cloneDate(event.occurredAt),
      lastEffectiveActivityAt: cloneDate(event.occurredAt),
    },
    "early-end report request",
  );
}

function validateReportStored(
  previous: Interview,
  current: Interview,
  event: InterviewEvent | undefined,
): void {
  if (
    event?.type !== "report_stored" ||
    previous.status !== "report_pending" ||
    previous.pendingReportKind !== event.reportKind ||
    previous.reportRequestedAt === null ||
    event.occurredAt.getTime() < previous.reportRequestedAt.getTime()
  ) {
    reject(previous.id, "stored report event does not match report-pending state");
  }
  assertAggregateEquals(
    current,
    {
      ...previous,
      version: previous.version + 1,
      status: event.reportKind === "complete" ? "completed" : "early_ended",
      pendingOperation: null,
      pendingReportKind: null,
      reportId: event.reportId,
    },
    "stored report transition",
  );
}

function validateAbandonment(
  previous: Interview,
  current: Interview,
  event: InterviewEvent | undefined,
): void {
  if (
    event?.type !== "interview_abandoned" ||
    previous.status !== "active" ||
    (previous.pendingOperation !== null &&
      event.operationId !== previous.pendingOperation.operationId)
  ) {
    reject(previous.id, "abandonment event does not match the active interview");
  }
  const fromAcceptedOperation = previous.pendingOperation !== null;
  assertAggregateEquals(
    current,
    {
      ...previous,
      version: fromAcceptedOperation ? previous.version : previous.version + 1,
      status: "abandoned",
      phase: null,
      pendingOperation: null,
      pendingReportKind: null,
      reportRequestedAt: null,
    },
    "interview abandonment",
  );
}

function assertPersistencePayloads(
  change: InterviewSave,
  expectsEvaluation: boolean,
  expectsReport: boolean,
): void {
  const evaluationEvents = change.events.filter(
    (event) => event.type === "question_evaluation_recorded",
  );
  const writes = change.evaluations ?? [];
  if (expectsEvaluation) {
    if (evaluationEvents.length !== 1 || writes.length !== 1) {
      reject(change.previous.id, "evaluation event and persistence payload counts disagree");
    }
    const event = evaluationEvents[0];
    const write = writes[0];
    if (
      event?.type !== "question_evaluation_recorded" ||
      write === undefined ||
      write.evaluationId !== event.evaluation.id ||
      write.questionPosition !== event.questionPosition ||
      !deepEqual(write.evaluation, event.evaluation) ||
      write.createdAt.getTime() !== event.occurredAt.getTime()
    ) {
      reject(change.previous.id, "evaluation persistence payload is mismatched");
    }
  } else if (writes.length !== 0) {
    reject(change.previous.id, "unexpected evaluation persistence payload");
  }

  const reportEvents = change.events.filter((event) => event.type === "report_stored");
  if (expectsReport) {
    const event = reportEvents[0];
    if (
      reportEvents.length !== 1 ||
      event?.type !== "report_stored" ||
      change.report === undefined ||
      change.report.id !== event.reportId ||
      change.report.kind !== event.reportKind ||
      change.report.createdAt.getTime() !== event.occurredAt.getTime()
    ) {
      reject(change.previous.id, "report event and persistence payload disagree");
    }
  } else if (change.report !== undefined) {
    reject(change.previous.id, "unexpected report persistence payload");
  }
}

function assertImmutableIdentity(change: InterviewSave): void {
  const { previous, current } = change;
  if (
    previous.id !== current.id ||
    previous.accountId !== current.accountId ||
    previous.questionCount !== current.questionCount ||
    previous.createdAt.getTime() !== current.createdAt.getTime() ||
    !deepEqual(previous.blueprint, current.blueprint)
  ) {
    throw new RepositoryImmutableConflictError("interview aggregate", previous.id);
  }
}

function assertEventIdentity(change: InterviewSave): void {
  for (const event of change.events) {
    if (
      event.type === "interview_created" ||
      event.interviewId !== change.previous.id ||
      !Number.isFinite(event.occurredAt.getTime())
    ) {
      reject(change.previous.id, "event identity, kind, or timestamp is invalid");
    }
  }
}

function requirePending(
  interview: Interview,
  operation: PendingInterviewOperation["operation"],
): PendingInterviewOperation {
  const pending = interview.pendingOperation;
  if (
    interview.status !== "active" ||
    interview.phase !== "processing" ||
    pending === null ||
    pending.operation !== operation ||
    pending.questionPosition !== interview.currentQuestionPosition
  ) {
    reject(interview.id, `expected a pending ${operation} Operation`);
  }
  return pending;
}

function assertSameOperation(
  interviewId: string,
  pending: PendingInterviewOperation,
  events: readonly InterviewEvent[],
): void {
  if (events.some((event) => event.operationId !== pending.operationId)) {
    reject(interviewId, "event Operation IDs do not match the pending Operation");
  }
}

function assertAnswerEvent(
  interview: Interview,
  pending: PendingInterviewOperation,
  event: Extract<InterviewEvent, { readonly type: "answer_material_submitted" }>,
): void {
  const expectedKind =
    pending.previousPhase === "awaiting_continue"
      ? "supplement"
      : getQuestion(interview, pending.questionPosition).systemFollowUps.length === 0
        ? "main_answer"
        : "follow_up_answer";
  if (
    event.questionPosition !== pending.questionPosition ||
    event.materialKind !== expectedKind ||
    event.occurredAt.getTime() > pending.acceptedAt.getTime() ||
    event.text.trim().length === 0
  ) {
    reject(interview.id, "answer-material event does not match the accepted Operation");
  }
}

function answerMaterialFrom(
  event: Extract<InterviewEvent, { readonly type: "answer_material_submitted" }>,
) {
  return {
    id: event.answerMaterialId,
    kind: event.materialKind,
    text: event.text,
    submittedAt: cloneDate(event.occurredAt),
  };
}

function replaceQuestion(
  interview: Interview,
  question: InterviewQuestionState,
  patch: Partial<Interview>,
): Interview {
  return {
    ...interview,
    ...patch,
    questions: interview.questions.map((candidate) =>
      candidate.position === question.position ? question : candidate,
    ),
  };
}

function getQuestion(interview: Interview, position: number): InterviewQuestionState {
  const question = interview.questions[position - 1];
  if (question === undefined || question.position !== position) {
    reject(interview.id, `question position ${position} is outside the aggregate`);
  }
  return question;
}

function clonePending(pending: PendingInterviewOperation): PendingInterviewOperation {
  return { ...pending, acceptedAt: cloneDate(pending.acceptedAt) };
}

function cloneDate(value: Date): Date {
  return new Date(value.getTime());
}

function assertAggregateEquals(actual: Interview, expected: Interview, transition: string): void {
  if (!deepEqual(actual, expected)) {
    reject(actual.id, `${transition} aggregate diff is not canonical`);
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => deepEqual(item, right[index]))
    );
  }
  if (typeof left === "object" && left !== null && typeof right === "object" && right !== null) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    return (
      sameSequence(leftKeys, rightKeys) &&
      leftKeys.every((key) => deepEqual(leftRecord[key], rightRecord[key]))
    );
  }
  return Object.is(left, right);
}

function sameSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function reject(interviewId: string, detail: string): never {
  throw new RepositoryCorruptionError("interview save", interviewId, detail);
}
