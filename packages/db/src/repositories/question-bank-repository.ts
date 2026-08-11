import { createHash } from "node:crypto";

import {
  type AccountId,
  normalizeQuestionBankSourcePath,
  parseQuestionId,
  type QuestionBankRepository,
  type QuestionDefinition,
  type QuestionId,
  type QuestionSnapshot,
} from "@interview-agent/domain";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import { questionBankVersions } from "../schema/index.js";
import {
  QuestionBankValidationError,
  QuestionBankVersionConflictError,
  RepositoryCorruptionError,
  RepositoryImmutableConflictError,
} from "./errors.js";
import { RepositoryExecution } from "./transaction.js";
import { decodeFollowUpGoalsAt, decodeRubricAt } from "./validation.js";

type QuestionBankVersionRow = typeof questionBankVersions.$inferSelect;

export interface QuestionBankImportEntry {
  readonly definition: QuestionDefinition;
  readonly schemaVersion: string;
  readonly sourceFile: string;
}

export interface QuestionBankImportRequest {
  readonly sourceName: string;
  readonly sourceVersion: number;
  readonly entries: readonly QuestionBankImportEntry[];
}

export interface QuestionBankImportResult {
  readonly importedAt: Date;
  readonly insertedCount: number;
  readonly noOpCount: number;
  readonly activatedCount: number;
  readonly retiredCount: number;
}

interface CanonicalQuestionContent {
  readonly questionId: string;
  readonly contentVersion: number;
  readonly domain: string;
  readonly difficulty: string;
  readonly questionType: string;
  readonly sourceWording: string;
  readonly rubric: readonly unknown[];
  readonly followUpGoals: readonly unknown[];
  readonly knowledgeExplanation: string;
  readonly sourceActive: boolean;
  readonly reviewed: boolean;
  readonly reviewedAt: string | null;
  readonly reviewedBy: string | null;
  readonly importSourceName: string;
  readonly importSourceVersion: number;
  readonly sourceSchemaVersion: string;
  readonly importSourceFile: string;
}

const IMPORT_ADVISORY_LOCK_KEY = 1_907_211_042;

function canonicalIncoming(
  request: QuestionBankImportRequest,
  entry: QuestionBankImportEntry,
): CanonicalQuestionContent {
  const { definition } = entry;
  return {
    questionId: String(definition.questionId),
    contentVersion: definition.questionVersion,
    domain: definition.domain,
    difficulty: definition.difficulty,
    questionType: definition.questionType,
    sourceWording: definition.sourceWording,
    rubric: definition.rubric.map((item) => ({
      id: String(item.id),
      description: item.description,
      weight: item.weight,
    })),
    followUpGoals: definition.followUpGoals.map((goal) => ({
      id: String(goal.id),
      kind: goal.kind,
      goal: goal.goal,
    })),
    knowledgeExplanation: definition.knowledgeExplanation,
    sourceActive: definition.active,
    reviewed: definition.reviewed,
    reviewedAt: definition.reviewMetadata?.reviewedAt.toISOString() ?? null,
    reviewedBy: definition.reviewMetadata?.reviewedBy ?? null,
    importSourceName: request.sourceName,
    importSourceVersion: request.sourceVersion,
    sourceSchemaVersion: entry.schemaVersion,
    importSourceFile: normalizeQuestionBankSourcePath(entry.sourceFile),
  };
}

function canonicalPersisted(row: QuestionBankVersionRow): CanonicalQuestionContent {
  return {
    questionId: row.questionId,
    contentVersion: row.contentVersion,
    domain: row.domain,
    difficulty: row.difficulty,
    questionType: row.questionType,
    sourceWording: row.sourceWording,
    rubric: row.rubric,
    followUpGoals: row.followUpGoals,
    knowledgeExplanation: row.knowledgeExplanation,
    sourceActive: row.sourceActive,
    reviewed: row.reviewed,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewedBy: row.reviewedBy,
    importSourceName: row.importSourceName,
    importSourceVersion: row.importSourceVersion,
    sourceSchemaVersion: row.sourceSchemaVersion,
    importSourceFile: row.importSourceFile,
  };
}

function serializeCanonical(value: CanonicalQuestionContent): string {
  return canonicalJson(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Question-bank canonical content contains an unsupported value");
}

export function questionBankSourceHash(
  request: QuestionBankImportRequest,
  entry: QuestionBankImportEntry,
): string {
  return createHash("sha256")
    .update(serializeCanonical(canonicalIncoming(request, entry)))
    .digest("hex");
}

function validateRequest(request: QuestionBankImportRequest): void {
  if (
    !request.sourceName.trim() ||
    !Number.isInteger(request.sourceVersion) ||
    request.sourceVersion < 1
  ) {
    throw new QuestionBankValidationError(undefined, undefined, "invalid_source_identity");
  }
  const identities = new Set<string>();
  for (const entry of request.entries) {
    const questionId = String(entry.definition.questionId);
    const identity = `${questionId}\0${entry.definition.questionVersion}`;
    if (identities.has(identity)) {
      throw new RepositoryImmutableConflictError(
        "question-bank version",
        `${questionId}@${entry.definition.questionVersion}`,
      );
    }
    identities.add(identity);
    if (!entry.schemaVersion.trim() || !entry.sourceFile.trim()) {
      throw new QuestionBankValidationError(
        questionId,
        entry.definition.questionVersion,
        "missing_source_metadata",
      );
    }
    try {
      normalizeQuestionBankSourcePath(entry.sourceFile);
    } catch {
      throw new QuestionBankValidationError(
        questionId,
        entry.definition.questionVersion,
        "invalid_source_path",
      );
    }
    if (entry.definition.active && !entry.definition.reviewed) {
      throw new QuestionBankValidationError(
        questionId,
        entry.definition.questionVersion,
        "active_unreviewed",
      );
    }
  }
}

export class PgQuestionBankRepository implements QuestionBankRepository {
  private readonly execution: RepositoryExecution;

  constructor(
    database: Database,
    execution: RepositoryExecution = new RepositoryExecution(database),
  ) {
    this.execution = execution;
  }

  listEligibleQuestions(): Promise<readonly QuestionSnapshot[]> {
    return this.execution.inTransaction(
      async (executor) => {
        const rows = await executor
          .select()
          .from(questionBankVersions)
          .where(
            and(
              eq(questionBankVersions.active, true),
              eq(questionBankVersions.sourceActive, true),
              eq(questionBankVersions.reviewed, true),
              eq(questionBankVersions.difficulty, "medium"),
            ),
          )
          .orderBy(asc(questionBankVersions.questionId), asc(questionBankVersions.contentVersion));
        return rows.map(questionSnapshotFromRow);
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  findQuestion(questionId: QuestionId, questionVersion: number): Promise<QuestionSnapshot | null> {
    if (!Number.isInteger(questionVersion) || questionVersion < 1) {
      throw new RangeError("Question version must be a positive integer");
    }
    return this.execution.inTransaction(
      async (executor) => {
        const rows = await executor
          .select()
          .from(questionBankVersions)
          .where(
            and(
              eq(questionBankVersions.questionId, questionId),
              eq(questionBankVersions.contentVersion, questionVersion),
            ),
          )
          .limit(1);
        return rows[0] === undefined ? null : questionSnapshotFromRow(rows[0]);
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  findRecentQuestionIds(
    accountId: AccountId,
    recentInterviewLimit: number,
  ): Promise<ReadonlySet<QuestionId>> {
    if (
      !Number.isInteger(recentInterviewLimit) ||
      recentInterviewLimit < 1 ||
      recentInterviewLimit > 100
    ) {
      throw new RangeError("Recent interview limit must be an integer from 1 through 100");
    }
    return this.execution.inTransaction(
      async (executor) => {
        const result = await executor.execute(sql<{ questionId: string }>`
          with recent_interviews as (
            select interview_sessions.id
              from interview_sessions
              inner join "user"
                on "user".id = interview_sessions.owner_user_id
             where interview_sessions.owner_user_id = ${accountId}
               and interview_sessions.status in ('completed', 'early_ended', 'abandoned')
               and interview_sessions.ended_at is not null
               and interview_sessions.deletion_requested_at is null
               and "user".deletion_requested_at is null
               and not exists (
                 select 1
                   from deletion_requests
                  where deletion_requests.interview_id = interview_sessions.id
                     or (
                       deletion_requests.scope = 'account'
                       and deletion_requests.owner_user_id = interview_sessions.owner_user_id
                     )
               )
             order by interview_sessions.ended_at desc, interview_sessions.id desc
             limit ${recentInterviewLimit}
          )
          select distinct session_question_snapshots.source_question_id as "questionId"
            from recent_interviews
            inner join session_question_snapshots
              on session_question_snapshots.interview_id = recent_interviews.id
           order by "questionId"
        `);
        return new Set(
          result.rows.map((row) => {
            const questionId = row["questionId"];
            if (typeof questionId !== "string") {
              throw new RepositoryCorruptionError(
                "recent interview question",
                "unknown",
                "source question ID is not a string",
              );
            }
            return decodeQuestionId(questionId, questionId);
          }),
        );
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  synchronize(request: QuestionBankImportRequest): Promise<QuestionBankImportResult> {
    validateRequest(request);
    return this.execution.inTransaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(${IMPORT_ADVISORY_LOCK_KEY})`);
      const timestampResult = await transaction.execute(
        sql<{ importedAt: Date }>`select statement_timestamp() as "importedAt"`,
      );
      const timestampRow = timestampResult.rows[0] as { readonly importedAt: unknown } | undefined;
      if (timestampRow === undefined) {
        throw new Error("PostgreSQL did not return statement_timestamp()");
      }
      const importedAt = new Date(String(timestampRow.importedAt));
      if (Number.isNaN(importedAt.valueOf())) {
        throw new Error("PostgreSQL returned an invalid statement_timestamp()");
      }

      const sortedEntries = [...request.entries].sort(
        (left, right) =>
          String(left.definition.questionId).localeCompare(String(right.definition.questionId)) ||
          left.definition.questionVersion - right.definition.questionVersion,
      );
      const questionIds = [
        ...new Set(sortedEntries.map((entry) => String(entry.definition.questionId))),
      ];
      const persisted =
        questionIds.length === 0
          ? []
          : await transaction
              .select()
              .from(questionBankVersions)
              .where(inArray(questionBankVersions.questionId, questionIds))
              .orderBy(
                asc(questionBankVersions.questionId),
                asc(questionBankVersions.contentVersion),
              );
      const rowsByQuestion = new Map<string, QuestionBankVersionRow[]>();
      for (const row of persisted) {
        const rows = rowsByQuestion.get(row.questionId) ?? [];
        rows.push(row);
        rowsByQuestion.set(row.questionId, rows);
      }

      let insertedCount = 0;
      let noOpCount = 0;
      let activatedCount = 0;
      let retiredCount = 0;

      for (const entry of sortedEntries) {
        const questionId = String(entry.definition.questionId);
        const rows = rowsByQuestion.get(questionId) ?? [];
        const existing = rows.find(
          (row) => row.contentVersion === entry.definition.questionVersion,
        );
        const incomingCanonical = canonicalIncoming(request, entry);
        const incomingSerialized = serializeCanonical(incomingCanonical);
        const incomingHash = questionBankSourceHash(request, entry);

        if (existing !== undefined) {
          const persistedSerialized = serializeCanonical(canonicalPersisted(existing));
          const persistedHash = createHash("sha256").update(persistedSerialized).digest("hex");
          if (existing.sourceHash !== persistedHash) {
            throw new RepositoryCorruptionError(
              "question-bank version",
              `${questionId}@${existing.contentVersion}`,
              "stored source hash does not match immutable content",
            );
          }
          if (persistedSerialized !== incomingSerialized || existing.sourceHash !== incomingHash) {
            throw new RepositoryImmutableConflictError(
              "question-bank version",
              `${questionId}@${existing.contentVersion}`,
            );
          }
          noOpCount += 1;
          continue;
        }

        const latestVersion = rows.at(-1)?.contentVersion ?? 0;
        if (entry.definition.questionVersion <= latestVersion) {
          throw new QuestionBankVersionConflictError(
            questionId,
            entry.definition.questionVersion,
            latestVersion,
          );
        }

        const retired = await transaction
          .update(questionBankVersions)
          .set({ active: false })
          .where(
            and(
              eq(questionBankVersions.questionId, questionId),
              eq(questionBankVersions.active, true),
            ),
          )
          .returning({ questionId: questionBankVersions.questionId });
        retiredCount += retired.length;

        const [inserted] = await transaction
          .insert(questionBankVersions)
          .values({
            questionId,
            contentVersion: entry.definition.questionVersion,
            domain: entry.definition.domain,
            difficulty: entry.definition.difficulty,
            questionType: entry.definition.questionType,
            sourceWording: entry.definition.sourceWording,
            rubric: entry.definition.rubric,
            followUpGoals: entry.definition.followUpGoals,
            knowledgeExplanation: entry.definition.knowledgeExplanation,
            active: entry.definition.active,
            sourceActive: entry.definition.active,
            reviewed: entry.definition.reviewed,
            reviewedAt: entry.definition.reviewMetadata?.reviewedAt ?? null,
            reviewedBy: entry.definition.reviewMetadata?.reviewedBy ?? null,
            importSourceName: request.sourceName,
            importSourceVersion: request.sourceVersion,
            sourceSchemaVersion: entry.schemaVersion,
            importSourceFile: normalizeQuestionBankSourcePath(entry.sourceFile),
            sourceHash: incomingHash,
            importedAt,
          })
          .returning();
        if (inserted === undefined) {
          throw new Error(`Question-bank version ${questionId} was not inserted`);
        }
        rows.push(inserted);
        rowsByQuestion.set(questionId, rows);
        insertedCount += 1;
        if (inserted.active) {
          activatedCount += 1;
        }
      }

      return {
        importedAt,
        insertedCount,
        noOpCount,
        activatedCount,
        retiredCount,
      };
    });
  }
}

function questionSnapshotFromRow(row: QuestionBankVersionRow): QuestionSnapshot {
  const identity = `${row.questionId}@${row.contentVersion}`;
  const canonicalHash = createHash("sha256")
    .update(serializeCanonical(canonicalPersisted(row)))
    .digest("hex");
  if (row.sourceHash !== canonicalHash) {
    throw new RepositoryCorruptionError(
      "question-bank version",
      identity,
      "stored source hash does not match immutable content",
    );
  }
  if (!Number.isInteger(row.contentVersion) || row.contentVersion < 1) {
    throw new RepositoryCorruptionError(
      "question-bank version",
      identity,
      "content version is invalid",
    );
  }
  const sourceWording = requireQuestionText(row.sourceWording, identity, "source wording");
  return {
    questionId: decodeQuestionId(row.questionId, identity),
    questionVersion: row.contentVersion,
    domain: row.domain,
    sourceWording,
    displayedWording: sourceWording,
    rubric: decodeRubricAt(row.rubric, {
      resource: "question-bank version",
      identifier: identity,
      field: "rubric",
    }),
    followUpGoals: decodeFollowUpGoalsAt(row.followUpGoals, {
      resource: "question-bank version",
      identifier: identity,
      field: "follow-up goals",
    }),
    knowledgeExplanation: requireQuestionText(
      row.knowledgeExplanation,
      identity,
      "knowledge explanation",
    ),
  };
}

function decodeQuestionId(value: string, identity: string): QuestionId {
  try {
    return parseQuestionId(value);
  } catch (error) {
    throw new RepositoryCorruptionError(
      "question-bank version",
      identity,
      "question ID is invalid",
      { cause: error },
    );
  }
}

function requireQuestionText(value: string, identity: string, field: string): string {
  if (value.trim().length === 0) {
    throw new RepositoryCorruptionError("question-bank version", identity, `${field} is blank`);
  }
  return value;
}
