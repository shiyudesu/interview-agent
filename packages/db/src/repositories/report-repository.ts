import type {
  AccountId,
  ImmutableReportSnapshot,
  InterviewId,
  ReportRepository,
} from "@interview-agent/domain";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import {
  interviewMessages,
  interviewSessions,
  questionEvaluations,
  reports,
  sessionQuestionSnapshots,
  user,
} from "../schema/index.js";
import {
  RepositoryCorruptionError,
  RepositoryImmutableConflictError,
  RepositoryNotFoundError,
} from "./errors.js";
import { loadInterviewAggregate } from "./interview-repository.js";
import { RepositoryExecution } from "./transaction.js";
import type { CreateStoredReport, StoredReport } from "./types.js";
import {
  assertReportMatchesInterview,
  decodeAccountId,
  decodeInterviewId,
  decodeModelMetadata,
  decodeReportId,
  decodeReportSnapshot,
  decodeRubric,
  decodeRubricEvaluations,
  isRecord,
} from "./validation.js";

const accessibleReport = sql`
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

export class PgReportRepository implements ReportRepository<StoredReport, CreateStoredReport> {
  private readonly execution: RepositoryExecution;

  constructor(
    database: Database,
    execution: RepositoryExecution = new RepositoryExecution(database),
  ) {
    this.execution = execution;
  }

  async findByInterviewId(
    interviewId: InterviewId,
    accountId: AccountId,
  ): Promise<StoredReport | null> {
    return this.execution.inTransaction(
      async (transaction) => {
        const interview = await loadInterviewAggregate(transaction, interviewId, accountId);
        if (interview === null) {
          return null;
        }
        if (interview.status !== "completed" && interview.status !== "early_ended") {
          return null;
        }
        if (interview.reportId === null) {
          throw new RepositoryCorruptionError(
            "report",
            interviewId,
            "terminal report lifecycle has no report ID",
          );
        }
        const rows = await transaction
          .select()
          .from(reports)
          .where(
            and(
              eq(reports.id, interview.reportId),
              eq(reports.interviewId, interviewId),
              eq(reports.ownerUserId, accountId),
            ),
          )
          .limit(2);
        const row = rows[0];
        if (rows.length !== 1 || row === undefined) {
          throw new RepositoryCorruptionError(
            "report",
            interviewId,
            "aggregate report row is missing or ambiguous",
          );
        }
        const report = decodeReport(row);
        if (
          (interview.status === "completed" && report.kind !== "complete") ||
          (interview.status === "early_ended" && report.kind !== "incomplete")
        ) {
          throw new RepositoryCorruptionError(
            "report",
            interviewId,
            "report kind disagrees with terminal interview status",
          );
        }
        assertReportMatchesInterview(report.snapshot, interview);
        return report;
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async insert(report: CreateStoredReport): Promise<void> {
    await this.execution.inTransaction(async (transaction) => {
      const interviews = await transaction
        .select({
          status: interviewSessions.status,
        })
        .from(interviewSessions)
        .innerJoin(user, eq(user.id, interviewSessions.ownerUserId))
        .where(
          and(
            eq(interviewSessions.id, report.interviewId),
            eq(interviewSessions.ownerUserId, report.accountId),
            isNull(interviewSessions.deletionRequestedAt),
            isNull(user.deletionRequestedAt),
            accessibleReport,
          ),
        )
        .limit(1);
      const interview = interviews[0];
      if (interview === undefined) {
        throw new RepositoryNotFoundError("terminal interview", report.interviewId);
      }
      if (
        !(
          (interview.status === "completed" && report.kind === "complete") ||
          (interview.status === "early_ended" && report.kind === "incomplete")
        )
      ) {
        throw new RepositoryImmutableConflictError("report kind", report.interviewId);
      }
      const modelMetadata = decodeModelMetadata(report.modelMetadata, "report", report.id);
      const snapshot = decodeReportSnapshot({
        value: report.snapshot,
        reportId: report.id,
        interviewId: report.interviewId,
        accountId: report.accountId,
        kind: report.kind,
        schemaVersion: report.schemaVersion,
        createdAt: report.createdAt,
        modelMetadata,
      });
      const questionRows = await transaction
        .select()
        .from(sessionQuestionSnapshots)
        .where(eq(sessionQuestionSnapshots.interviewId, report.interviewId))
        .orderBy(asc(sessionQuestionSnapshots.position));
      const materialRows = await transaction
        .select({
          id: interviewMessages.id,
          questionPosition: interviewMessages.questionPosition,
        })
        .from(interviewMessages)
        .where(
          and(
            eq(interviewMessages.interviewId, report.interviewId),
            inArray(interviewMessages.kind, ["main_answer", "follow_up_answer", "supplement"]),
          ),
        );
      const evaluationRows = await transaction
        .select({ evaluation: questionEvaluations })
        .from(questionEvaluations)
        .innerJoin(
          sessionQuestionSnapshots,
          eq(sessionQuestionSnapshots.id, questionEvaluations.questionSnapshotId),
        )
        .where(eq(sessionQuestionSnapshots.interviewId, report.interviewId));
      assertSnapshotMatchesStoredInterview(
        snapshot,
        questionRows,
        materialRows,
        evaluationRows.map((row) => row.evaluation),
      );
      try {
        await transaction.insert(reports).values({
          id: report.id,
          interviewId: report.interviewId,
          ownerUserId: report.accountId,
          kind: report.kind,
          schemaVersion: report.schemaVersion,
          snapshot,
          modelMetadata: report.modelMetadata,
          createdAt: report.createdAt,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new RepositoryImmutableConflictError("report", report.interviewId, {
            cause: error,
          });
        }

        function isUniqueViolation(error: unknown): boolean {
          return (
            isRecord(error) &&
            (error["code"] === "23505" ||
              (isRecord(error["cause"]) && error["cause"]["code"] === "23505"))
          );
        }
        throw error;
      }
    });
  }
}

function assertSnapshotMatchesStoredInterview(
  snapshot: ImmutableReportSnapshot,
  questions: readonly (typeof sessionQuestionSnapshots.$inferSelect)[],
  materials: readonly {
    readonly id: string;
    readonly questionPosition: number | null;
  }[],
  evaluations: readonly (typeof questionEvaluations.$inferSelect)[],
): void {
  const expectedQuestions =
    snapshot.kind === "complete"
      ? questions
      : questions.filter((question) => question.outcomeKind !== null);
  if (snapshot.questions.length !== expectedQuestions.length) {
    throw new RepositoryCorruptionError(
      "report",
      snapshot.reportId,
      "question feedback does not cover persisted question outcomes",
    );
  }
  const materialIdsByPosition = new Map<number, Set<string>>();
  for (const material of materials) {
    if (material.questionPosition !== null) {
      const ids = materialIdsByPosition.get(material.questionPosition) ?? new Set<string>();
      ids.add(material.id);
      materialIdsByPosition.set(material.questionPosition, ids);
    }
  }
  const evaluationsBySnapshot = new Map(
    evaluations.map((evaluation) => [evaluation.questionSnapshotId, evaluation] as const),
  );
  for (const feedback of snapshot.questions) {
    const question = questions[feedback.position - 1];
    if (
      question === undefined ||
      question.position !== feedback.position ||
      question.sourceQuestionId !== feedback.questionId ||
      question.sourceQuestionVersion !== feedback.questionVersion ||
      question.domain !== feedback.domain ||
      question.displayWording !== feedback.displayedQuestion ||
      question.outcomeKind !== feedback.outcome ||
      question.score !== feedback.score
    ) {
      throw new RepositoryCorruptionError(
        "report",
        snapshot.reportId,
        `question feedback at position ${feedback.position} disagrees with persistence`,
      );
    }
    const materialIds = materialIdsByPosition.get(feedback.position) ?? new Set<string>();
    if (
      feedback.evidence.some(
        (evidence) =>
          evidence.source === "answer_material" && !materialIds.has(evidence.answerMaterialId),
      )
    ) {
      throw new RepositoryCorruptionError(
        "report",
        snapshot.reportId,
        `question ${feedback.position} references unknown answer material`,
      );
    }
    const rubric = decodeRubric(question.rubric, snapshot.interviewId, feedback.position);
    const rubricIds = new Set(rubric.map((item) => item.id));
    const evaluationRow = evaluationsBySnapshot.get(question.id);
    const evaluationItems =
      evaluationRow === undefined
        ? []
        : decodeRubricEvaluations(
            evaluationRow.rubricResults,
            snapshot.interviewId,
            evaluationRow.id,
          );
    const evaluationByRubricId = new Map(
      evaluationItems.map((item) => [item.rubricItemId, item] as const),
    );
    const evaluationEvidenceIds = new Set(
      evaluationItems.flatMap((item) => item.evidenceMaterialIds),
    );
    if (
      evaluationRow !== undefined &&
      feedback.evidence.some(
        (evidence) =>
          evidence.source === "answer_material" &&
          !evaluationEvidenceIds.has(evidence.answerMaterialId),
      )
    ) {
      throw new RepositoryCorruptionError(
        "report",
        snapshot.reportId,
        `question ${feedback.position} evidence disagrees with evaluation`,
      );
    }
    for (const point of feedback.matchedKnowledgePoints) {
      const evaluation = evaluationByRubricId.get(point.rubricItemId);
      if (
        !rubricIds.has(point.rubricItemId) ||
        evaluation === undefined ||
        evaluation.awardedPoints <= 0 ||
        point.awardedPoints !== evaluation.awardedPoints ||
        point.evidence.some(
          (evidence) =>
            evidence.source === "answer_material" &&
            !evaluation.evidenceMaterialIds.includes(evidence.answerMaterialId),
        )
      ) {
        throw new RepositoryCorruptionError(
          "report",
          snapshot.reportId,
          `question ${feedback.position} matched Rubric award disagrees with evaluation`,
        );
      }
    }
    for (const point of feedback.missingOrIncorrectPoints) {
      const evaluation = evaluationByRubricId.get(point.rubricItemId);
      if (
        !rubricIds.has(point.rubricItemId) ||
        (evaluation !== undefined &&
          !evaluation.missingOrIncorrectPoints.includes(point.summary)) ||
        (evaluation === undefined &&
          question.outcomeKind !== "unknown" &&
          question.outcomeKind !== "skipped") ||
        point.evidence.some(
          (evidence) =>
            evidence.source === "answer_material" &&
            (evaluation === undefined ||
              !evaluation.evidenceMaterialIds.includes(evidence.answerMaterialId)),
        )
      ) {
        throw new RepositoryCorruptionError(
          "report",
          snapshot.reportId,
          `question ${feedback.position} missing point disagrees with evaluation`,
        );
      }
    }
  }
}

function decodeReport(row: typeof reports.$inferSelect): StoredReport {
  if (row.schemaVersion.trim().length === 0 || !Number.isFinite(row.createdAt.getTime())) {
    throw new RepositoryCorruptionError(
      "report",
      row.id,
      "schema version or creation time is invalid",
    );
  }
  const interviewId = decodeInterviewId(row.interviewId, "report", row.id);
  const accountId = decodeAccountId(row.ownerUserId, "report", row.id);
  const modelMetadata = decodeModelMetadata(row.modelMetadata, "report", row.id);
  const snapshot = decodeReportSnapshot({
    value: row.snapshot,
    reportId: row.id,
    interviewId,
    accountId,
    kind: row.kind,
    schemaVersion: row.schemaVersion,
    createdAt: row.createdAt,
    modelMetadata,
  });
  return {
    id: decodeReportId(row.id, "report", row.id),
    interviewId,
    accountId,
    kind: row.kind,
    schemaVersion: row.schemaVersion,
    snapshot,
    modelMetadata,
    createdAt: row.createdAt,
  };
}
