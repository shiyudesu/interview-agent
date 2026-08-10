import type {
  AccountId,
  AnswerMaterial,
  FollowUpPurpose,
  ImmutableReportSnapshot,
  Interview,
  InterviewEvent,
  InterviewId,
  InterviewPhase,
  InterviewQuestionCount,
  InterviewQuestionState,
  InterviewRepository,
  InterviewStatus,
  KnowledgeDomain,
  QuestionOutcome,
  ReportKind,
  ResponseClassification,
} from "@interview-agent/domain";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import {
  interviewMessages,
  interviewSessions,
  operations,
  questionEvaluations,
  reports,
  sessionQuestionSnapshots,
  user,
} from "../schema/index.js";
import {
  RepositoryCorruptionError,
  RepositoryImmutableConflictError,
  RepositoryNotFoundError,
  RepositoryVersionConflictError,
} from "./errors.js";
import type { DatabaseExecutor } from "./transaction.js";
import { RepositoryExecution } from "./transaction.js";
import { validateInterviewSave } from "./transition-validation.js";
import type {
  EvaluationPersistence,
  InterviewDetail,
  InterviewHistoryEntry,
  InterviewSave,
  ReportPersistence,
} from "./types.js";
import {
  assertReportMatchesInterview,
  decodeAccountId,
  decodeAnswerMaterialId,
  decodeFollowUpGoals,
  decodeInterviewId,
  decodeMessageId,
  decodeModelMetadata,
  decodeOperationId,
  decodeQuestionEvaluation,
  decodeQuestionId,
  decodeReportId,
  decodeReportSnapshot,
  decodeRubric,
  decodeSnapshotOutcome,
  isRecord,
  requiredMetadataString,
  requireRecordMetadata,
} from "./validation.js";

type SessionRow = typeof interviewSessions.$inferSelect;
type SnapshotRow = typeof sessionQuestionSnapshots.$inferSelect;
type MessageRow = typeof interviewMessages.$inferSelect;
type EvaluationRow = typeof questionEvaluations.$inferSelect;
type ReportRow = typeof reports.$inferSelect;
type OperationRow = typeof operations.$inferSelect;

const inaccessibleInterview = sql`
  not exists (
    select 1
      from deletion_requests
     where deletion_requests.interview_id = ${interviewSessions.id}
        or (
          deletion_requests.scope = 'account'
          and deletion_requests.owner_user_id = ${interviewSessions.ownerUserId}
        )
  )
`;

export class PgInterviewRepository implements InterviewRepository<Interview, InterviewSave> {
  private readonly execution: RepositoryExecution;

  constructor(
    database: Database,
    execution: RepositoryExecution = new RepositoryExecution(database),
  ) {
    this.execution = execution;
  }

  findById(interviewId: InterviewId, accountId?: AccountId): Promise<Interview | null> {
    return this.execution.inTransaction(
      (transaction) => loadInterviewAggregate(transaction, interviewId, accountId),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  findActiveByAccountId(accountId: AccountId): Promise<Interview | null> {
    return this.execution.inTransaction(
      async (transaction) => {
        const rows = await transaction
          .select({ id: interviewSessions.id })
          .from(interviewSessions)
          .innerJoin(user, eq(user.id, interviewSessions.ownerUserId))
          .where(
            and(
              eq(interviewSessions.ownerUserId, accountId),
              inArray(interviewSessions.status, ["active", "report_pending"]),
              isNull(interviewSessions.deletionRequestedAt),
              isNull(user.deletionRequestedAt),
              inaccessibleInterview,
            ),
          )
          .limit(2);
        if (rows.length > 1) {
          throw new RepositoryCorruptionError(
            "account interviews",
            accountId,
            "more than one active or report-pending interview exists",
          );
        }
        const row = rows[0];
        return row === undefined
          ? null
          : loadInterviewAggregate(
              transaction,
              decodeInterviewId(row.id, "interview", row.id),
              accountId,
            );
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  create(interview: Interview): Promise<void> {
    return this.execution.inTransaction(async (transaction) => {
      assertCreateState(interview);
      try {
        await transaction.insert(interviewSessions).values({
          id: interview.id,
          ownerUserId: interview.accountId,
          selectedQuestionCount: interview.questionCount,
          selectionSeed: interview.blueprint.selectionSeed,
          status: interview.status,
          activePhase: interview.phase,
          version: interview.version,
          currentQuestionPosition: interview.currentQuestionPosition,
          createdAt: interview.createdAt,
          lastEffectiveActivityAt: interview.lastEffectiveActivityAt,
        });
        await transaction.insert(sessionQuestionSnapshots).values(
          interview.blueprint.questions.map((item) => ({
            id: snapshotId(interview.id, item.position),
            interviewId: interview.id,
            position: item.position,
            sourceQuestionId: item.question.questionId,
            sourceQuestionVersion: item.question.questionVersion,
            domain: item.question.domain,
            sourceWording: item.question.sourceWording,
            displayWording: item.question.displayedWording,
            rubric: item.question.rubric,
            followUpGoals: item.question.followUpGoals,
            knowledgeExplanation: item.question.knowledgeExplanation,
            createdAt: interview.createdAt,
          })),
        );
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new RepositoryImmutableConflictError("interview", interview.id, {
            cause: error,
          });
        }
        throw error;
      }
    });
  }

  async save(change: InterviewSave): Promise<void> {
    validateInterviewSave(change);
    return this.execution.inTransaction(async (transaction) => {
      await this.validatePendingOperationReference(
        transaction,
        change.current.pendingOperation ?? change.previous.pendingOperation,
        change.previous,
        change.current.pendingOperation === null
          ? change.previous.version - 1
          : change.previous.version,
        change.current.pendingOperation !== null
          ? "processing"
          : change.events.length === 0 || change.current.status === "abandoned"
            ? "failed"
            : "succeeded",
      );
      const terminalAt = terminalEventTime(change.events);
      const updated = await transaction
        .update(interviewSessions)
        .set({
          status: change.current.status,
          activePhase: change.current.phase,
          version: change.current.version,
          currentQuestionPosition: change.current.currentQuestionPosition,
          pendingOperationId: change.current.pendingOperation?.operationId ?? null,
          pendingOperationKind: change.current.pendingOperation?.operation ?? null,
          pendingOperationQuestionPosition:
            change.current.pendingOperation?.questionPosition ?? null,
          pendingOperationAcceptedAt: change.current.pendingOperation?.acceptedAt ?? null,
          pendingOperationPreviousPhase: change.current.pendingOperation?.previousPhase ?? null,
          pendingReportKind: change.current.pendingReportKind,
          reportRequestedAt: change.current.reportRequestedAt,
          lastEffectiveActivityAt: change.current.lastEffectiveActivityAt,
          endedAt: terminalAt ?? interviewSessions.endedAt,
        })
        .where(
          and(
            eq(interviewSessions.id, change.previous.id),
            eq(interviewSessions.version, change.previous.version),
            change.previous.pendingOperation === null
              ? isNull(interviewSessions.pendingOperationId)
              : eq(
                  interviewSessions.pendingOperationId,
                  change.previous.pendingOperation.operationId,
                ),
          ),
        )
        .returning({ id: interviewSessions.id });

      if (updated.length === 0) {
        await this.throwSaveConflict(transaction, change.previous);
      }

      await this.persistEvents(
        transaction,
        change.current,
        change.events,
        change.evaluations ?? [],
        change.report,
      );
    });
  }

  listHistory(accountId: AccountId, limit = 50): Promise<readonly InterviewHistoryEntry[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("History limit must be an integer from 1 through 100");
    }
    return this.execution.inTransaction(
      async (transaction) => {
        const rows = await transaction
          .select({
            session: interviewSessions,
            report: reports,
          })
          .from(interviewSessions)
          .innerJoin(user, eq(user.id, interviewSessions.ownerUserId))
          .leftJoin(reports, eq(reports.interviewId, interviewSessions.id))
          .where(
            and(
              eq(interviewSessions.ownerUserId, accountId),
              inArray(interviewSessions.status, ["completed", "early_ended", "abandoned"]),
              isNull(interviewSessions.deletionRequestedAt),
              isNull(user.deletionRequestedAt),
              inaccessibleInterview,
            ),
          )
          .orderBy(desc(interviewSessions.endedAt), desc(interviewSessions.id))
          .limit(limit);
        if (rows.length === 0) {
          return [];
        }
        const interviewIds = rows.map((row) => row.session.id);
        const snapshotEvaluationRows = await transaction
          .select({
            snapshot: sessionQuestionSnapshots,
            evaluation: questionEvaluations,
          })
          .from(sessionQuestionSnapshots)
          .leftJoin(
            questionEvaluations,
            eq(questionEvaluations.questionSnapshotId, sessionQuestionSnapshots.id),
          )
          .where(inArray(sessionQuestionSnapshots.interviewId, interviewIds))
          .orderBy(
            asc(sessionQuestionSnapshots.interviewId),
            asc(sessionQuestionSnapshots.position),
          );
        const messageRows = await transaction
          .select()
          .from(interviewMessages)
          .where(inArray(interviewMessages.interviewId, interviewIds))
          .orderBy(asc(interviewMessages.interviewId), asc(interviewMessages.sequence));
        const snapshotsByInterview = new Map<string, SnapshotRow[]>();
        const evaluationsByInterview = new Map<string, EvaluationRow[]>();
        for (const row of snapshotEvaluationRows) {
          const snapshots = snapshotsByInterview.get(row.snapshot.interviewId) ?? [];
          snapshots.push(row.snapshot);
          snapshotsByInterview.set(row.snapshot.interviewId, snapshots);
          if (row.evaluation !== null) {
            const evaluations = evaluationsByInterview.get(row.snapshot.interviewId) ?? [];
            evaluations.push(row.evaluation);
            evaluationsByInterview.set(row.snapshot.interviewId, evaluations);
          }
        }
        const messagesByInterview = groupByInterviewId(messageRows);
        const history: InterviewHistoryEntry[] = [];
        for (const row of rows) {
          const { report, session } = row;
          if (session.endedAt === null) {
            throw new RepositoryCorruptionError(
              "interview history",
              session.id,
              "terminal interview has no endedAt",
            );
          }
          if (
            session.status !== "completed" &&
            session.status !== "early_ended" &&
            session.status !== "abandoned"
          ) {
            throw new RepositoryCorruptionError(
              "interview history",
              session.id,
              `unexpected status ${session.status}`,
            );
          }
          if (
            (session.status === "completed" && (report === null || report.kind !== "complete")) ||
            (session.status === "early_ended" &&
              (report === null || report.kind !== "incomplete")) ||
            (session.status === "abandoned" && report !== null)
          ) {
            throw new RepositoryCorruptionError(
              "interview history",
              session.id,
              "report and score projection disagrees with status",
            );
          }
          const reconstructed = reconstructInterview(
            session,
            snapshotsByInterview.get(session.id) ?? [],
            messagesByInterview.get(session.id) ?? [],
            evaluationsByInterview.get(session.id) ?? [],
            report === null ? [] : [report],
            [],
          );
          const decodedSnapshot =
            report === null
              ? null
              : decodeReportSnapshot({
                  value: report.snapshot,
                  reportId: report.id,
                  interviewId: decodeInterviewId(session.id, "interview history", session.id),
                  accountId,
                  kind: report.kind,
                  schemaVersion: report.schemaVersion,
                  createdAt: report.createdAt,
                  modelMetadata: decodeModelMetadata(
                    report.modelMetadata,
                    "interview history",
                    report.id,
                  ),
                });
          const overallScore =
            session.status === "completed" &&
            decodedSnapshot !== null &&
            decodedSnapshot.kind === "complete"
              ? decodedSnapshot.overallScore
              : null;
          if (decodedSnapshot !== null) {
            assertReportMatchesInterview(decodedSnapshot, reconstructed);
          }
          if (
            overallScore !== null &&
            (typeof overallScore !== "number" || !Number.isInteger(overallScore))
          ) {
            throw new RepositoryCorruptionError(
              "interview history",
              session.id,
              "complete report score is invalid",
            );
          }
          history.push({
            interviewId: decodeInterviewId(session.id, "interview history", session.id),
            createdAt: validDate(session.createdAt, session.id, "createdAt"),
            endedAt: validDate(session.endedAt, session.id, "endedAt"),
            direction: session.direction,
            questionCount: decodeQuestionCount(session.selectedQuestionCount, session.id),
            status: session.status,
            overallScore,
            reportId:
              report === null ? null : decodeReportId(report.id, "interview history", session.id),
          });
        }
        return history;
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  findDetailByOwner(
    interviewId: InterviewId,
    accountId: AccountId,
  ): Promise<InterviewDetail | null> {
    return this.execution.inTransaction(
      async (transaction) => {
        const interview = await loadInterviewAggregate(transaction, interviewId, accountId);
        if (interview === null) {
          return null;
        }
        const sessionRows = await transaction
          .select({ endedAt: interviewSessions.endedAt })
          .from(interviewSessions)
          .where(eq(interviewSessions.id, interviewId))
          .limit(1);
        const messageRows = await transaction
          .select()
          .from(interviewMessages)
          .where(eq(interviewMessages.interviewId, interviewId))
          .orderBy(asc(interviewMessages.sequence));
        const endedAt = sessionRows[0]?.endedAt ?? null;
        const byPosition = new Map<
          number,
          InterviewDetail["questions"][number]["messages"][number][]
        >();
        for (const message of messageRows) {
          if (message.kind === "main_question") {
            continue;
          }
          if (
            message.kind !== "main_answer" &&
            message.kind !== "follow_up_answer" &&
            message.kind !== "supplement" &&
            message.kind !== "question_clarification" &&
            message.kind !== "system_follow_up" &&
            message.kind !== "transition"
          ) {
            throw new RepositoryCorruptionError(
              "interview detail",
              interview.id,
              `message ${message.id} kind invalid`,
            );
          }
          const position = message.questionPosition;
          if (position === null || position < 1 || position > interview.questionCount) {
            throw new RepositoryCorruptionError(
              "interview detail",
              interview.id,
              `message ${message.id} question position invalid`,
            );
          }
          const projected = {
            id: message.id,
            operationId:
              message.operationId === null
                ? null
                : decodeOperationId(message.operationId, "interview detail", interview.id),
            role: message.role,
            kind: message.kind,
            content: message.content,
            createdAt: validDate(message.createdAt, interview.id, "message createdAt"),
          };
          const existing = byPosition.get(position) ?? [];
          existing.push(projected);
          byPosition.set(position, existing);
        }
        const revealedQuestionCount = transcriptQuestionCount(interview, messageRows);
        const revealedBlueprintQuestions = interview.blueprint.questions.slice(
          0,
          revealedQuestionCount,
        );
        const revealedQuestionStates = interview.questions.slice(0, revealedQuestionCount);
        return {
          interview: {
            ...interview,
            blueprint: {
              ...interview.blueprint,
              questions: revealedBlueprintQuestions,
            },
            questions: revealedQuestionStates,
          },
          endedAt: endedAt === null ? null : validDate(endedAt, interview.id, "interview endedAt"),
          questions: revealedBlueprintQuestions.map((item) => ({
            position: item.position,
            displayedQuestion: item.question.displayedWording,
            messages: byPosition.get(item.position) ?? [],
          })),
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  private async throwSaveConflict(executor: DatabaseExecutor, previous: Interview): Promise<never> {
    const rows = await executor
      .select({
        version: interviewSessions.version,
        pendingOperationId: interviewSessions.pendingOperationId,
      })
      .from(interviewSessions)
      .where(eq(interviewSessions.id, previous.id))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new RepositoryNotFoundError("interview", previous.id);
    }
    if (row.version !== previous.version) {
      throw new RepositoryVersionConflictError(previous.id, previous.version, row.version);
    }
    throw new RepositoryImmutableConflictError("interview state", previous.id);
  }

  private async validatePendingOperationReference(
    executor: DatabaseExecutor,
    pendingOperation: Interview["pendingOperation"],
    previous: Interview,
    expectedVersion: number,
    expectedStatus: OperationRow["status"],
  ): Promise<void> {
    if (pendingOperation === null) {
      return;
    }
    const rows = await executor
      .select()
      .from(operations)
      .where(eq(operations.id, pendingOperation.operationId))
      .limit(2);
    const operation = rows[0];
    if (
      rows.length !== 1 ||
      operation === undefined ||
      !pendingOperationMatchesRow(
        {
          id: previous.id,
          accountId: previous.accountId,
          version: expectedVersion,
          currentQuestionPosition: previous.currentQuestionPosition,
        },
        pendingOperation,
        operation,
        expectedStatus,
      )
    ) {
      throw new RepositoryCorruptionError(
        "interview save",
        previous.id,
        "pending Operation metadata does not match its persisted Operation",
      );
    }
  }

  private async persistEvents(
    transaction: DatabaseExecutor,
    interview: Interview,
    events: readonly InterviewEvent[],
    evaluationWrites: readonly EvaluationPersistence[],
    reportWrite: ReportPersistence | undefined,
  ): Promise<void> {
    const evaluationsById = new Map(
      evaluationWrites.map((write) => [write.evaluationId, write] as const),
    );
    let storedReport = false;
    const hasMessageEvents = events.some(
      (event) =>
        event.type === "answer_material_submitted" ||
        event.type === "question_clarification_recorded" ||
        event.type === "system_follow_up_recorded",
    );
    let nextMessageSequence = 0;
    if (hasMessageEvents) {
      const rows = await transaction
        .select({
          maximum: sql<number>`coalesce(max(${interviewMessages.sequence}), 0)`,
        })
        .from(interviewMessages)
        .where(eq(interviewMessages.interviewId, interview.id));
      nextMessageSequence = rows[0]?.maximum ?? 0;
    }

    for (const event of events) {
      const snapshot = interview.blueprint.questions[eventQuestionPosition(event) - 1];
      switch (event.type) {
        case "interview_created":
        case "question_clarification_requested":
        case "report_requested":
        case "interview_abandoned":
          break;
        case "answer_material_submitted":
          await transaction.insert(interviewMessages).values({
            id: event.answerMaterialId,
            interviewId: interview.id,
            sequence: ++nextMessageSequence,
            questionSnapshotId: requiredSnapshotId(interview.id, snapshot, event.questionPosition),
            questionPosition: event.questionPosition,
            role: "user",
            kind: event.materialKind,
            answerMaterialKind: event.materialKind,
            content: event.text,
            operationId: event.operationId,
            createdAt: event.occurredAt,
          });
          break;
        case "question_clarification_recorded": {
          const request = events.find(
            (candidate) =>
              candidate.type === "question_clarification_requested" &&
              candidate.operationId === event.operationId,
          );
          if (request?.type !== "question_clarification_requested") {
            throw new RepositoryCorruptionError(
              "interview save",
              interview.id,
              "clarification completion has no matching request event",
            );
          }
          await transaction.insert(interviewMessages).values({
            id: event.messageId,
            interviewId: interview.id,
            sequence: ++nextMessageSequence,
            questionSnapshotId: requiredSnapshotId(interview.id, snapshot, event.questionPosition),
            questionPosition: event.questionPosition,
            role: "assistant",
            kind: "question_clarification",
            content: event.text,
            operationId: event.operationId,
            metadata: { requestedAt: request.occurredAt.toISOString() },
            createdAt: event.occurredAt,
          });
          break;
        }
        case "system_follow_up_recorded":
          await transaction.insert(interviewMessages).values({
            id: event.messageId,
            interviewId: interview.id,
            sequence: ++nextMessageSequence,
            questionSnapshotId: requiredSnapshotId(interview.id, snapshot, event.questionPosition),
            questionPosition: event.questionPosition,
            role: "assistant",
            kind: "system_follow_up",
            content: event.text,
            operationId: event.operationId,
            metadata: {
              goalId: event.goalId,
              kind: event.kind,
              purpose: event.purpose,
              responseClassification: event.responseClassification,
            },
            createdAt: event.occurredAt,
          });
          break;
        case "question_outcome_cleared":
          await transaction
            .delete(questionEvaluations)
            .where(
              eq(
                questionEvaluations.questionSnapshotId,
                requiredSnapshotId(interview.id, snapshot, event.questionPosition),
              ),
            );
          await clearSnapshotOutcome(transaction, interview.id, event.questionPosition);
          break;
        case "question_evaluation_recorded": {
          const write = evaluationsById.get(event.evaluation.id);
          if (
            write === undefined ||
            write.questionPosition !== event.questionPosition ||
            write.evaluation !== event.evaluation
          ) {
            throw new RepositoryCorruptionError(
              "interview save",
              interview.id,
              `evaluation ${event.evaluation.id} metadata is missing or mismatched`,
            );
          }
          decodeModelMetadata(write.modelMetadata, "evaluation", write.evaluationId);
          const snapshotIdValue = requiredSnapshotId(
            interview.id,
            snapshot,
            event.questionPosition,
          );
          await transaction
            .delete(questionEvaluations)
            .where(eq(questionEvaluations.questionSnapshotId, snapshotIdValue));
          await transaction.insert(questionEvaluations).values({
            id: write.evaluationId,
            questionSnapshotId: snapshotIdValue,
            classification: write.evaluation.classification,
            rubricResults: write.evaluation.rubricItems,
            outcomeKind: write.evaluation.outcome.kind,
            score: write.evaluation.outcome.score,
            zeroScoreReason:
              write.evaluation.outcome.kind === "scored"
                ? null
                : write.evaluation.outcome.zeroScoreReason,
            modelMetadata: write.modelMetadata,
            createdAt: write.createdAt,
          });
          await setSnapshotOutcome(
            transaction,
            interview.id,
            event.questionPosition,
            write.evaluation.outcome,
          );
          evaluationsById.delete(event.evaluation.id);
          break;
        }
        case "unevaluated_question_outcome_recorded":
          await transaction
            .delete(questionEvaluations)
            .where(
              eq(
                questionEvaluations.questionSnapshotId,
                requiredSnapshotId(interview.id, snapshot, event.questionPosition),
              ),
            );
          await setSnapshotOutcome(
            transaction,
            interview.id,
            event.questionPosition,
            event.outcome,
          );
          break;
        case "question_frozen":
          await transaction
            .update(sessionQuestionSnapshots)
            .set({ frozen: true, frozenAt: event.occurredAt })
            .where(
              and(
                eq(sessionQuestionSnapshots.interviewId, interview.id),
                eq(sessionQuestionSnapshots.position, event.questionPosition),
              ),
            );
          break;
        case "report_stored":
          if (
            reportWrite === undefined ||
            reportWrite.id !== event.reportId ||
            reportWrite.kind !== event.reportKind
          ) {
            throw new RepositoryCorruptionError(
              "interview save",
              interview.id,
              "report transition has no matching report persistence payload",
            );
          }
          await insertReport(transaction, interview, reportWrite);
          storedReport = true;
          break;
      }
    }

    if (evaluationsById.size !== 0) {
      throw new RepositoryCorruptionError(
        "interview save",
        interview.id,
        "unused evaluation persistence payload",
      );
    }
    if (reportWrite !== undefined && !storedReport) {
      throw new RepositoryCorruptionError(
        "interview save",
        interview.id,
        "report payload has no report_stored event",
      );
    }
  }
}

export async function loadInterviewAggregate(
  executor: DatabaseExecutor,
  interviewId: InterviewId,
  accountId?: AccountId,
): Promise<Interview | null> {
  const sessions = await executor
    .select({ session: interviewSessions })
    .from(interviewSessions)
    .innerJoin(user, eq(user.id, interviewSessions.ownerUserId))
    .where(
      and(
        eq(interviewSessions.id, interviewId),
        accountId === undefined ? sql`true` : eq(interviewSessions.ownerUserId, accountId),
        ne(interviewSessions.status, "deleting"),
        isNull(interviewSessions.deletionRequestedAt),
        isNull(user.deletionRequestedAt),
        inaccessibleInterview,
      ),
    )
    .limit(1);
  const session = sessions[0]?.session;
  if (session === undefined) {
    return null;
  }

  const snapshots = await executor
    .select()
    .from(sessionQuestionSnapshots)
    .where(eq(sessionQuestionSnapshots.interviewId, interviewId))
    .orderBy(asc(sessionQuestionSnapshots.position));
  const messages = await executor
    .select()
    .from(interviewMessages)
    .where(eq(interviewMessages.interviewId, interviewId))
    .orderBy(asc(interviewMessages.sequence));
  const evaluations = await executor
    .select({ evaluation: questionEvaluations, snapshot: sessionQuestionSnapshots })
    .from(questionEvaluations)
    .innerJoin(
      sessionQuestionSnapshots,
      eq(sessionQuestionSnapshots.id, questionEvaluations.questionSnapshotId),
    )
    .where(eq(sessionQuestionSnapshots.interviewId, interviewId))
    .orderBy(asc(sessionQuestionSnapshots.position));
  const reportRows = await executor
    .select()
    .from(reports)
    .where(eq(reports.interviewId, interviewId))
    .limit(2);
  const pendingOperationRows =
    session.pendingOperationId === null
      ? []
      : await executor
          .select()
          .from(operations)
          .where(eq(operations.id, session.pendingOperationId))
          .limit(2);
  return reconstructInterview(
    session,
    snapshots,
    messages,
    evaluations.map((row) => row.evaluation),
    reportRows,
    pendingOperationRows,
  );
}

function groupByInterviewId<Row extends { readonly interviewId: string }>(
  rows: readonly Row[],
): Map<string, Row[]> {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const existing = grouped.get(row.interviewId) ?? [];
    existing.push(row);
    grouped.set(row.interviewId, existing);
  }
  return grouped;
}

function transcriptQuestionCount(interview: Interview, messages: readonly MessageRow[]): number {
  const allQuestionsFrozen = interview.questions.every(
    (question) => question.frozen && question.outcome !== null,
  );
  if (
    interview.status === "completed" ||
    (interview.status === "report_pending" &&
      interview.pendingReportKind === "complete" &&
      allQuestionsFrozen)
  ) {
    return interview.questionCount;
  }

  const currentPosition = interview.currentQuestionPosition;
  const current = interview.questions[currentPosition - 1];
  const previous = interview.questions[currentPosition - 2];
  const highestMessagePosition = messages.reduce(
    (highest, message) =>
      message.questionPosition !== null && message.questionPosition <= currentPosition
        ? Math.max(highest, message.questionPosition)
        : highest,
    0,
  );
  const currentHasVisibleState =
    currentPosition === 1 ||
    previous?.frozen === true ||
    (current !== undefined &&
      (current.answerMaterial.length > 0 ||
        current.questionClarifications.length > 0 ||
        current.systemFollowUps.length > 0 ||
        current.outcome !== null));
  return Math.min(
    currentPosition,
    Math.max(
      highestMessagePosition,
      currentHasVisibleState ? currentPosition : currentPosition - 1,
    ),
  );
}

function reconstructInterview(
  session: SessionRow,
  snapshots: readonly SnapshotRow[],
  messages: readonly MessageRow[],
  evaluations: readonly EvaluationRow[],
  reportRows: readonly ReportRow[],
  pendingOperationRows: readonly OperationRow[],
): Interview {
  const interviewId = decodeInterviewId(session.id, "interview", session.id);
  const accountId = decodeAccountId(session.ownerUserId, "interview", session.id);
  const questionCount = decodeQuestionCount(session.selectedQuestionCount, session.id);
  if (snapshots.length !== questionCount) {
    throw new RepositoryCorruptionError(
      "interview",
      session.id,
      `expected ${questionCount} snapshots, found ${snapshots.length}`,
    );
  }
  const messagesByPosition = new Map<number, MessageRow[]>();
  for (const [index, message] of messages.entries()) {
    if (message.sequence !== index + 1) {
      throw new RepositoryCorruptionError(
        "interview",
        session.id,
        `message sequence must be contiguous from 1; found ${message.sequence} at ${index + 1}`,
      );
    }
    if (message.questionPosition === null) {
      if (message.kind !== "transition") {
        throw new RepositoryCorruptionError(
          "interview",
          session.id,
          `message ${message.id} is missing a question position`,
        );
      }
      continue;
    }
    const existing = messagesByPosition.get(message.questionPosition) ?? [];
    existing.push(message);
    messagesByPosition.set(message.questionPosition, existing);
  }
  const evaluationBySnapshot = new Map<string, EvaluationRow>();
  for (const evaluation of evaluations) {
    if (evaluationBySnapshot.has(evaluation.questionSnapshotId)) {
      throw new RepositoryCorruptionError(
        "interview",
        session.id,
        `multiple evaluations exist for snapshot ${evaluation.questionSnapshotId}`,
      );
    }
    decodeModelMetadata(evaluation.modelMetadata, "evaluation", evaluation.id);
    evaluationBySnapshot.set(evaluation.questionSnapshotId, evaluation);
  }

  const blueprintQuestions = snapshots.map((snapshot, index) => {
    const position = index + 1;
    if (snapshot.position !== position) {
      throw new RepositoryCorruptionError(
        "interview",
        session.id,
        `snapshot position ${snapshot.position} is not contiguous at ${position}`,
      );
    }
    return {
      position,
      question: {
        questionId: decodeQuestionId(snapshot.sourceQuestionId, session.id),
        questionVersion: requirePositiveInteger(
          snapshot.sourceQuestionVersion,
          session.id,
          `question ${position} version`,
        ),
        domain: decodeDomain(snapshot.domain, session.id, position),
        sourceWording: requireNonEmpty(snapshot.sourceWording, session.id, "source wording"),
        displayedWording: requireNonEmpty(snapshot.displayWording, session.id, "display wording"),
        rubric: decodeRubric(snapshot.rubric, session.id, position),
        followUpGoals: decodeFollowUpGoals(snapshot.followUpGoals, session.id, position),
        knowledgeExplanation: requireNonEmpty(
          snapshot.knowledgeExplanation,
          session.id,
          "knowledge explanation",
        ),
      },
    };
  });

  const questions = snapshots.map((snapshot) =>
    reconstructQuestion(
      session.id,
      snapshot,
      blueprintQuestions[snapshot.position - 1]?.question.rubric ?? [],
      blueprintQuestions[snapshot.position - 1]?.question.followUpGoals ?? [],
      messagesByPosition.get(snapshot.position) ?? [],
      evaluationBySnapshot.get(snapshot.id),
    ),
  );
  const reportState = reconstructReportState(session, reportRows);
  const pendingOperation = reconstructPendingOperation(session, pendingOperationRows);
  const interview: Interview = {
    id: interviewId,
    accountId,
    version: requirePositiveInteger(session.version, session.id, "version"),
    status: decodeStatus(session.status, session.id),
    phase: decodePhase(session.activePhase, session.id),
    questionCount,
    blueprint: {
      selectionSeed: requireNonEmpty(session.selectionSeed, session.id, "selection seed"),
      questions: blueprintQuestions,
    },
    currentQuestionPosition: requirePosition(
      session.currentQuestionPosition,
      questionCount,
      session.id,
    ),
    questions,
    pendingOperation,
    pendingReportKind: decodeReportKind(session.pendingReportKind, session.id),
    reportRequestedAt: validNullableDate(
      session.reportRequestedAt,
      session.id,
      "reportRequestedAt",
    ),
    reportId: reportState?.reportId ?? null,
    createdAt: validDate(session.createdAt, session.id, "createdAt"),
    lastEffectiveActivityAt: validDate(
      session.lastEffectiveActivityAt,
      session.id,
      "lastEffectiveActivityAt",
    ),
  };
  assertReconstructedState(interview, session.endedAt);
  if (reportState !== null) {
    assertReportMatchesInterview(reportState.snapshot, interview);
  }
  return interview;
}

function reconstructQuestion(
  interviewId: string,
  snapshot: SnapshotRow,
  rubric: ReturnType<typeof decodeRubric>,
  followUpGoals: ReturnType<typeof decodeFollowUpGoals>,
  messages: readonly MessageRow[],
  evaluationRow: EvaluationRow | undefined,
): InterviewQuestionState {
  const answerMaterial: AnswerMaterial[] = [];
  const questionClarifications: InterviewQuestionState["questionClarifications"][number][] = [];
  const systemFollowUps: InterviewQuestionState["systemFollowUps"][number][] = [];
  const messageIds = new Set<string>();
  for (const message of messages) {
    if (messageIds.has(message.id)) {
      throw new RepositoryCorruptionError(
        "interview",
        interviewId,
        `duplicate message ${message.id}`,
      );
    }
    messageIds.add(message.id);
    if (message.kind !== "transition" && message.questionSnapshotId !== snapshot.id) {
      throw new RepositoryCorruptionError(
        "interview",
        interviewId,
        `message ${message.id} references the wrong question snapshot`,
      );
    }
    if (
      message.kind === "main_answer" ||
      message.kind === "follow_up_answer" ||
      message.kind === "supplement"
    ) {
      if (
        message.role !== "user" ||
        message.answerMaterialKind !== message.kind ||
        message.content.trim().length === 0
      ) {
        throw new RepositoryCorruptionError(
          "interview",
          interviewId,
          `answer material ${message.id} columns disagree`,
        );
      }
      answerMaterial.push({
        id: decodeAnswerMaterialId(message.id, interviewId),
        kind: message.kind,
        text: message.content,
        submittedAt: validDate(message.createdAt, interviewId, "answer submittedAt"),
      });
      continue;
    }
    if (message.kind === "question_clarification") {
      if (message.role !== "assistant") {
        throw new RepositoryCorruptionError(
          "interview",
          interviewId,
          `clarification ${message.id} role invalid`,
        );
      }
      const metadata = requireRecordMetadata(message.metadata, interviewId, message.id);
      questionClarifications.push({
        messageId: decodeMessageId(message.id, interviewId),
        text: requireNonEmpty(message.content, interviewId, "clarification text"),
        requestedAt: parseIsoDate(
          requiredMetadataString(metadata, "requestedAt", interviewId, message.id),
          interviewId,
          `message ${message.id} requestedAt`,
        ),
        recordedAt: validDate(message.createdAt, interviewId, "clarification recordedAt"),
      });
      const clarification = questionClarifications.at(-1);
      if (
        clarification !== undefined &&
        clarification.requestedAt.getTime() > clarification.recordedAt.getTime()
      ) {
        throw new RepositoryCorruptionError(
          "interview",
          interviewId,
          `clarification ${message.id} was recorded before it was requested`,
        );
      }
      continue;
    }
    if (message.kind === "system_follow_up") {
      if (message.role !== "assistant") {
        throw new RepositoryCorruptionError(
          "interview",
          interviewId,
          `follow-up ${message.id} role invalid`,
        );
      }
      const metadata = requireRecordMetadata(message.metadata, interviewId, message.id);
      systemFollowUps.push({
        messageId: decodeMessageId(message.id, interviewId),
        goalId: decodeGoalId(
          requiredMetadataString(metadata, "goalId", interviewId, message.id),
          interviewId,
        ),
        kind: decodeFollowUpKind(
          requiredMetadataString(metadata, "kind", interviewId, message.id),
          interviewId,
        ),
        purpose: decodeFollowUpPurpose(
          requiredMetadataString(metadata, "purpose", interviewId, message.id),
          interviewId,
        ),
        responseClassification: decodeClassification(
          requiredMetadataString(metadata, "responseClassification", interviewId, message.id),
          interviewId,
        ),
        text: requireNonEmpty(message.content, interviewId, "follow-up text"),
        recordedAt: validDate(message.createdAt, interviewId, "follow-up recordedAt"),
      });
    }
  }
  const usedGoalIds = new Set<string>();
  const usedKinds = new Set<string>();
  for (const followUp of systemFollowUps) {
    const goal = followUpGoals.find((candidate) => candidate.id === followUp.goalId);
    if (
      goal === undefined ||
      goal.kind !== followUp.kind ||
      usedGoalIds.has(followUp.goalId) ||
      usedKinds.has(followUp.kind) ||
      (followUp.purpose === "depth" ? followUp.kind !== "depth" : followUp.kind !== "clarification")
    ) {
      throw new RepositoryCorruptionError(
        "interview",
        interviewId,
        `follow-up ${followUp.messageId} violates the frozen question goals`,
      );
    }
    usedGoalIds.add(followUp.goalId);
    usedKinds.add(followUp.kind);
  }
  const answerMaterialIds = new Set(answerMaterial.map((material) => material.id));
  const outcome = decodeSnapshotOutcome({
    interviewId,
    position: snapshot.position,
    outcomeKind: snapshot.outcomeKind,
    score: snapshot.score,
    zeroScoreReason: snapshot.zeroScoreReason,
  });
  const evaluation =
    evaluationRow === undefined
      ? null
      : decodeQuestionEvaluation({
          interviewId,
          evaluationId: evaluationRow.id,
          classification: evaluationRow.classification,
          rubricResults: evaluationRow.rubricResults,
          outcomeKind: evaluationRow.outcomeKind,
          score: evaluationRow.score,
          zeroScoreReason: evaluationRow.zeroScoreReason,
          rubric,
          answerMaterialIds,
        });
  if (snapshot.frozen !== (snapshot.frozenAt !== null)) {
    throw new RepositoryCorruptionError(
      "interview",
      interviewId,
      `question ${snapshot.position} frozen columns disagree`,
    );
  }
  if (!outcomesEqual(outcome, evaluation?.outcome ?? null)) {
    if (
      !(
        evaluation === null &&
        (outcome?.kind === "unknown" || outcome?.kind === "skipped" || outcome === null)
      )
    ) {
      throw new RepositoryCorruptionError(
        "interview",
        interviewId,
        `question ${snapshot.position} snapshot and evaluation outcomes disagree`,
      );
    }
  }
  return {
    position: snapshot.position,
    answerMaterial,
    questionClarifications,
    systemFollowUps,
    evaluation,
    outcome,
    frozen: snapshot.frozen,
  };
}

function reconstructPendingOperation(
  session: SessionRow,
  operationRows: readonly OperationRow[],
): Interview["pendingOperation"] {
  const values = [
    session.pendingOperationId,
    session.pendingOperationKind,
    session.pendingOperationQuestionPosition,
    session.pendingOperationAcceptedAt,
    session.pendingOperationPreviousPhase,
  ];
  if (values.every((value) => value === null)) {
    if (operationRows.length !== 0) {
      throw new RepositoryCorruptionError(
        "interview",
        session.id,
        "unexpected pending Operation row was loaded",
      );
    }
    return null;
  }
  if (values.some((value) => value === null)) {
    throw new RepositoryCorruptionError(
      "interview",
      session.id,
      "pending Operation metadata is partially null",
    );
  }
  if (
    session.pendingOperationId === null ||
    session.pendingOperationKind === null ||
    session.pendingOperationQuestionPosition === null ||
    session.pendingOperationAcceptedAt === null ||
    (session.pendingOperationPreviousPhase !== "awaiting_response" &&
      session.pendingOperationPreviousPhase !== "awaiting_continue")
  ) {
    throw new RepositoryCorruptionError(
      "interview",
      session.id,
      "pending Operation metadata is invalid",
    );
  }
  if (operationRows.length !== 1) {
    throw new RepositoryCorruptionError(
      "interview",
      session.id,
      "pending Operation row is missing or ambiguous",
    );
  }
  const operation = operationRows[0];
  const acceptedAt = validDate(
    session.pendingOperationAcceptedAt,
    session.id,
    "pendingOperation.acceptedAt",
  );
  const pendingOperation = {
    operationId: decodeOperationId(session.pendingOperationId, "interview", session.id),
    operation: session.pendingOperationKind,
    questionPosition: session.pendingOperationQuestionPosition,
    acceptedAt,
    previousPhase: session.pendingOperationPreviousPhase,
  } as const;
  const interviewForMatch = {
    id: decodeInterviewId(session.id, "interview", session.id),
    accountId: decodeAccountId(session.ownerUserId, "interview", session.id),
    version: session.version - 1,
    currentQuestionPosition: session.currentQuestionPosition,
  };
  if (
    operation === undefined ||
    session.activePhase !== "processing" ||
    session.pendingOperationQuestionPosition !== session.currentQuestionPosition ||
    !pendingOperationMatchesRow(interviewForMatch, pendingOperation, operation, "processing")
  ) {
    throw new RepositoryCorruptionError(
      "interview",
      session.id,
      "pending Operation row disagrees with accepted aggregate state",
    );
  }
  return pendingOperation;
}

function pendingOperationMatchesRow(
  interview: Pick<Interview, "id" | "accountId" | "version" | "currentQuestionPosition">,
  pending: NonNullable<Interview["pendingOperation"]>,
  operation: OperationRow,
  expectedStatus: OperationRow["status"],
): boolean {
  const expectedType =
    pending.operation === "question_clarification"
      ? pending.previousPhase === "awaiting_response"
        ? "request_question_clarification"
        : null
      : pending.previousPhase === "awaiting_response"
        ? "submit_answer"
        : pending.previousPhase === "awaiting_continue"
          ? "submit_supplement"
          : null;
  return (
    expectedType !== null &&
    pending.questionPosition === interview.currentQuestionPosition &&
    Number.isInteger(pending.questionPosition) &&
    pending.questionPosition >= 1 &&
    Number.isFinite(pending.acceptedAt.getTime()) &&
    operation.id === pending.operationId &&
    operation.interviewId === interview.id &&
    operation.ownerUserId === interview.accountId &&
    operation.type === expectedType &&
    operation.idempotencyScope === expectedType &&
    operation.expectedVersion === interview.version &&
    operation.createdAt.getTime() === pending.acceptedAt.getTime() &&
    operation.status === expectedStatus &&
    isRecord(operation.input) &&
    operation.input["questionPosition"] === pending.questionPosition
  );
}

function reconstructReportState(
  session: SessionRow,
  reportRows: readonly ReportRow[],
): {
  readonly reportId: ReturnType<typeof decodeReportId>;
  readonly snapshot: ImmutableReportSnapshot;
} | null {
  if (reportRows.length > 1) {
    throw new RepositoryCorruptionError(
      "interview",
      session.id,
      "multiple immutable reports exist",
    );
  }
  const report = reportRows[0];
  if (report === undefined) {
    if (session.status === "completed" || session.status === "early_ended") {
      throw new RepositoryCorruptionError(
        "interview",
        session.id,
        "terminal report status has no report",
      );
    }
    return null;
  }
  const interviewId = decodeInterviewId(session.id, "interview", session.id);
  if (report.interviewId !== session.id || report.ownerUserId !== session.ownerUserId) {
    throw new RepositoryCorruptionError(
      "interview",
      session.id,
      "report ownership columns disagree with the aggregate",
    );
  }
  const snapshot = decodeReportSnapshot({
    value: report.snapshot,
    reportId: report.id,
    interviewId,
    accountId: decodeAccountId(session.ownerUserId, "interview", session.id),
    kind: report.kind,
    schemaVersion: report.schemaVersion,
    createdAt: report.createdAt,
    modelMetadata: decodeModelMetadata(report.modelMetadata, "report", report.id),
  });
  if (
    (session.status === "completed" && report.kind !== "complete") ||
    (session.status === "early_ended" && report.kind !== "incomplete") ||
    (session.status !== "completed" && session.status !== "early_ended")
  ) {
    throw new RepositoryCorruptionError(
      "interview",
      session.id,
      "report kind disagrees with interview status",
    );
  }
  return {
    reportId: decodeReportId(report.id, "interview", session.id),
    snapshot,
  };
}

function assertReconstructedState(interview: Interview, endedAt: Date | null): void {
  if (interview.createdAt.getTime() > interview.lastEffectiveActivityAt.getTime()) {
    throw new RepositoryCorruptionError(
      "interview",
      interview.id,
      "last activity precedes creation",
    );
  }
  if (interview.status === "active") {
    if (interview.phase === null || interview.pendingReportKind !== null) {
      throw new RepositoryCorruptionError(
        "interview",
        interview.id,
        "active lifecycle state is inconsistent",
      );
    }
  } else if (interview.phase !== null) {
    throw new RepositoryCorruptionError(
      "interview",
      interview.id,
      "non-active interview has an active phase",
    );
  }
  if (
    (interview.phase === "processing") !== (interview.pendingOperation !== null) ||
    (interview.pendingOperation !== null &&
      (interview.pendingOperation.questionPosition !== interview.currentQuestionPosition ||
        interview.pendingOperation.acceptedAt.getTime() !==
          interview.lastEffectiveActivityAt.getTime()))
  ) {
    throw new RepositoryCorruptionError(
      "interview",
      interview.id,
      "processing phase and pending Operation disagree",
    );
  }
  if (
    interview.status === "report_pending"
      ? interview.pendingReportKind === null || interview.reportRequestedAt === null
      : interview.pendingReportKind !== null
  ) {
    throw new RepositoryCorruptionError(
      "interview",
      interview.id,
      "report-pending metadata disagrees with status",
    );
  }
  const isEnded =
    interview.status === "completed" ||
    interview.status === "early_ended" ||
    interview.status === "abandoned";
  if (isEnded !== (endedAt !== null)) {
    throw new RepositoryCorruptionError(
      "interview",
      interview.id,
      "endedAt disagrees with terminal status",
    );
  }
  for (const [index, question] of interview.questions.entries()) {
    const position = index + 1;
    if (question.position !== position) {
      throw new RepositoryCorruptionError(
        "interview",
        interview.id,
        "question state positions are not contiguous",
      );
    }
    if (question.frozen && question.outcome === null) {
      throw new RepositoryCorruptionError(
        "interview",
        interview.id,
        `question ${position} is frozen without an outcome`,
      );
    }
    if (position < interview.currentQuestionPosition && !question.frozen) {
      throw new RepositoryCorruptionError(
        "interview",
        interview.id,
        `past question ${position} is not frozen`,
      );
    }
    if (position < interview.currentQuestionPosition && question.outcome === null) {
      throw new RepositoryCorruptionError(
        "interview",
        interview.id,
        `past question ${position} has no outcome`,
      );
    }
    if (position > interview.currentQuestionPosition && !isPristineQuestion(question)) {
      throw new RepositoryCorruptionError(
        "interview",
        interview.id,
        `future question ${position} is not pristine`,
      );
    }
  }

  const current = interview.questions[interview.currentQuestionPosition - 1];
  if (current === undefined) {
    throw new RepositoryCorruptionError(
      "interview",
      interview.id,
      "current question state is missing",
    );
  }
  const waitingForFollowUpAnswer =
    current.systemFollowUps.length >
    current.answerMaterial.filter((material) => material.kind === "follow_up_answer").length;
  const assertResponseState = (): void => {
    if (current.frozen || (current.outcome !== null && !waitingForFollowUpAnswer)) {
      throw new RepositoryCorruptionError(
        "interview",
        interview.id,
        "current awaiting-response question state is inconsistent",
      );
    }
  };

  if (interview.status === "active") {
    if (interview.phase === "awaiting_response") {
      assertResponseState();
    } else if (interview.phase === "awaiting_continue") {
      if (current.frozen || current.outcome === null) {
        throw new RepositoryCorruptionError(
          "interview",
          interview.id,
          "current awaiting-continue question must have an unfrozen outcome",
        );
      }
    } else if (interview.phase === "processing") {
      if (interview.pendingOperation?.previousPhase === "awaiting_response") {
        assertResponseState();
      } else if (
        interview.pendingOperation?.previousPhase !== "awaiting_continue" ||
        current.frozen ||
        current.outcome === null
      ) {
        throw new RepositoryCorruptionError(
          "interview",
          interview.id,
          "processing question state disagrees with its previous phase",
        );
      }
    }
  }

  if (
    (interview.status === "completed" ||
      (interview.status === "report_pending" && interview.pendingReportKind === "complete")) &&
    interview.questions.some((question) => !question.frozen || question.outcome === null)
  ) {
    throw new RepositoryCorruptionError(
      "interview",
      interview.id,
      "complete-report lifecycle requires every selected question to be frozen with an outcome",
    );
  }
  if (
    (interview.status === "report_pending" && interview.pendingReportKind === "incomplete") ||
    interview.status === "early_ended"
  ) {
    if (!interview.questions.some((question) => question.outcome !== null) || current.frozen) {
      throw new RepositoryCorruptionError(
        "interview",
        interview.id,
        "incomplete-report lifecycle has an invalid assessed prefix",
      );
    }
  }
  if (interview.status === "abandoned" && current.frozen) {
    throw new RepositoryCorruptionError(
      "interview",
      interview.id,
      "abandoned interview cannot freeze its current question",
    );
  }
}

function isPristineQuestion(question: InterviewQuestionState): boolean {
  return (
    question.answerMaterial.length === 0 &&
    question.questionClarifications.length === 0 &&
    question.systemFollowUps.length === 0 &&
    question.evaluation === null &&
    question.outcome === null &&
    !question.frozen
  );
}

function assertCreateState(interview: Interview): void {
  if (
    interview.version !== 1 ||
    interview.status !== "active" ||
    interview.phase !== "awaiting_response" ||
    interview.currentQuestionPosition !== 1 ||
    interview.pendingOperation !== null ||
    interview.pendingReportKind !== null ||
    interview.reportRequestedAt !== null ||
    interview.reportId !== null ||
    interview.questions.length !== interview.questionCount ||
    interview.questions.some(
      (question) =>
        question.answerMaterial.length !== 0 ||
        question.questionClarifications.length !== 0 ||
        question.systemFollowUps.length !== 0 ||
        question.evaluation !== null ||
        question.outcome !== null ||
        question.frozen,
    )
  ) {
    throw new RepositoryCorruptionError(
      "interview creation",
      interview.id,
      "aggregate is not a pristine created interview",
    );
  }
}

async function insertReport(
  transaction: DatabaseExecutor,
  interview: Interview,
  report: ReportPersistence,
): Promise<void> {
  const modelMetadata = decodeModelMetadata(report.modelMetadata, "report", report.id);
  const snapshot = decodeReportSnapshot({
    value: report.snapshot,
    reportId: report.id,
    interviewId: interview.id,
    accountId: interview.accountId,
    kind: report.kind,
    schemaVersion: report.schemaVersion,
    createdAt: report.createdAt,
    modelMetadata,
  });
  assertReportMatchesInterview(snapshot, interview);
  try {
    await transaction.insert(reports).values({
      id: report.id,
      interviewId: interview.id,
      ownerUserId: interview.accountId,
      kind: report.kind,
      schemaVersion: requireNonEmpty(report.schemaVersion, report.id, "schema version"),
      snapshot,
      modelMetadata: report.modelMetadata,
      createdAt: report.createdAt,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new RepositoryImmutableConflictError("report", interview.id, { cause: error });
    }
    throw error;
  }
}

async function setSnapshotOutcome(
  executor: DatabaseExecutor,
  interviewId: InterviewId,
  position: number,
  outcome: QuestionOutcome,
): Promise<void> {
  await executor
    .update(sessionQuestionSnapshots)
    .set({
      outcomeKind: outcome.kind,
      score: outcome.score,
      zeroScoreReason: outcome.kind === "scored" ? null : outcome.zeroScoreReason,
    })
    .where(
      and(
        eq(sessionQuestionSnapshots.interviewId, interviewId),
        eq(sessionQuestionSnapshots.position, position),
      ),
    );
}

async function clearSnapshotOutcome(
  executor: DatabaseExecutor,
  interviewId: InterviewId,
  position: number,
): Promise<void> {
  await executor
    .update(sessionQuestionSnapshots)
    .set({ outcomeKind: null, score: null, zeroScoreReason: null })
    .where(
      and(
        eq(sessionQuestionSnapshots.interviewId, interviewId),
        eq(sessionQuestionSnapshots.position, position),
      ),
    );
}

function terminalEventTime(events: readonly InterviewEvent[]): Date | null {
  for (const event of events) {
    if (event.type === "report_stored" || event.type === "interview_abandoned") {
      return event.occurredAt;
    }
  }
  return null;
}

function eventQuestionPosition(event: InterviewEvent): number {
  switch (event.type) {
    case "answer_material_submitted":
    case "question_clarification_requested":
    case "question_clarification_recorded":
    case "system_follow_up_recorded":
    case "question_outcome_cleared":
    case "question_evaluation_recorded":
    case "unevaluated_question_outcome_recorded":
    case "question_frozen":
      return event.questionPosition;
    case "interview_created":
    case "report_requested":
    case "report_stored":
    case "interview_abandoned":
      return 0;
  }
}

function requiredSnapshotId(
  interviewId: InterviewId,
  snapshot: Interview["blueprint"]["questions"][number] | undefined,
  position: number,
): string {
  if (snapshot === undefined || snapshot.position !== position) {
    throw new RepositoryCorruptionError(
      "interview save",
      interviewId,
      `question position ${position} is outside the blueprint`,
    );
  }
  return snapshotId(interviewId, position);
}

function snapshotId(interviewId: InterviewId, position: number): string {
  return `${interviewId}:question:${position}`;
}

function decodeQuestionCount(value: number, interviewId: string): InterviewQuestionCount {
  if (value === 5 || value === 10 || value === 15) {
    return value;
  }
  throw new RepositoryCorruptionError(
    "interview",
    interviewId,
    `unsupported question count ${value}`,
  );
}

function decodeStatus(value: string, interviewId: string): InterviewStatus {
  switch (value) {
    case "active":
    case "report_pending":
    case "completed":
    case "early_ended":
    case "abandoned":
    case "deleting":
      return value;
    default:
      throw new RepositoryCorruptionError("interview", interviewId, `status ${value} invalid`);
  }
}

function decodePhase(value: string | null, interviewId: string): InterviewPhase | null {
  if (
    value === null ||
    value === "awaiting_response" ||
    value === "processing" ||
    value === "awaiting_continue"
  ) {
    return value;
  }
  throw new RepositoryCorruptionError("interview", interviewId, `phase ${value} invalid`);
}

function decodeDomain(value: string, interviewId: string, position: number): KnowledgeDomain {
  switch (value) {
    case "go_language":
    case "concurrency_runtime_performance":
    case "http_rpc_api":
    case "database_storage":
    case "cache_messaging_distributed":
    case "testing_observability_engineering":
      return value;
    default:
      throw new RepositoryCorruptionError(
        "interview",
        interviewId,
        `question ${position} domain ${value} invalid`,
      );
  }
}

function decodeReportKind(value: string | null, interviewId: string): ReportKind | null {
  if (value === null || value === "complete" || value === "incomplete") {
    return value;
  }
  throw new RepositoryCorruptionError("interview", interviewId, `report kind ${value} invalid`);
}

function decodeGoalId(value: string, interviewId: string) {
  const goals = decodeFollowUpGoals(
    [{ id: value, kind: "clarification", goal: "placeholder" }],
    interviewId,
    0,
  );
  const goal = goals[0];
  if (goal === undefined) {
    throw new RepositoryCorruptionError("interview", interviewId, "follow-up goal ID invalid");
  }
  return goal.id;
}

function decodeFollowUpKind(value: string, interviewId: string) {
  if (value === "clarification" || value === "depth") {
    return value;
  }
  throw new RepositoryCorruptionError("interview", interviewId, `follow-up kind ${value} invalid`);
}

function decodeFollowUpPurpose(value: string, interviewId: string): FollowUpPurpose {
  if (
    value === "answer_clarification" ||
    value === "irrelevant_response_clarification" ||
    value === "depth"
  ) {
    return value;
  }
  throw new RepositoryCorruptionError(
    "interview",
    interviewId,
    `follow-up purpose ${value} invalid`,
  );
}

function decodeClassification(value: string, interviewId: string): ResponseClassification {
  if (value === "relevant" || value === "ambiguous" || value === "irrelevant") {
    return value;
  }
  throw new RepositoryCorruptionError(
    "interview",
    interviewId,
    `response classification ${value} invalid`,
  );
}

function requirePositiveInteger(value: number, interviewId: string, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RepositoryCorruptionError("interview", interviewId, `${field} invalid`);
  }
  return value;
}

function requirePosition(
  value: number,
  questionCount: InterviewQuestionCount,
  interviewId: string,
): number {
  if (!Number.isInteger(value) || value < 1 || value > questionCount) {
    throw new RepositoryCorruptionError(
      "interview",
      interviewId,
      `current question position ${value} invalid`,
    );
  }
  return value;
}

function requireNonEmpty(value: string, identifier: string, field: string): string {
  if (value.trim().length === 0) {
    throw new RepositoryCorruptionError("persisted value", identifier, `${field} is empty`);
  }
  return value;
}

function validDate(value: Date, interviewId: string, field: string): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new RepositoryCorruptionError("interview", interviewId, `${field} invalid`);
  }
  return new Date(value.getTime());
}

function validNullableDate(value: Date | null, interviewId: string, field: string): Date | null {
  return value === null ? null : validDate(value, interviewId, field);
}

function parseIsoDate(value: string, interviewId: string, field: string): Date {
  const date = new Date(value);
  return validDate(date, interviewId, field);
}

function outcomesEqual(left: QuestionOutcome | null, right: QuestionOutcome | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return (
    left.kind === right.kind &&
    left.score === right.score &&
    ("zeroScoreReason" in left
      ? "zeroScoreReason" in right && left.zeroScoreReason === right.zeroScoreReason
      : !("zeroScoreReason" in right))
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    isRecord(error) &&
    (error["code"] === "23505" || (isRecord(error["cause"]) && error["cause"]["code"] === "23505"))
  );
}
