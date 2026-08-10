import type {
  AnswerMaterialKind,
  FollowUpGoalSnapshot,
  ImmutableReportSnapshot,
  InterviewPhase,
  InterviewQuestionCount,
  InterviewStatus,
  KnowledgeDomain,
  ModelCallMetadata,
  QuestionOutcomeKind,
  ReportKind,
  ResponseClassification,
  RubricItemEvaluation,
  RubricItemSnapshot,
  ZeroScoreReason,
} from "@interview-agent/domain";
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { user } from "./auth.js";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export const interviewDirectionEnum = pgEnum("interview_direction", ["go_backend"]);
export const interviewStatusEnum = pgEnum("interview_status", [
  "active",
  "report_pending",
  "completed",
  "early_ended",
  "abandoned",
  "deleting",
]);
export const interviewPhaseEnum = pgEnum("interview_phase", [
  "awaiting_response",
  "processing",
  "awaiting_continue",
]);
export const knowledgeDomainEnum = pgEnum("knowledge_domain", [
  "go_language",
  "concurrency_runtime_performance",
  "http_rpc_api",
  "database_storage",
  "cache_messaging_distributed",
  "testing_observability_engineering",
]);
export const questionDifficultyEnum = pgEnum("question_difficulty", ["medium"]);
export const questionOutcomeKindEnum = pgEnum("question_outcome_kind", [
  "scored",
  "incorrect",
  "unknown",
  "skipped",
  "irrelevant",
]);
export const evaluationOutcomeKindEnum = pgEnum("evaluation_outcome_kind", [
  "scored",
  "incorrect",
  "irrelevant",
]);
export const zeroScoreReasonEnum = pgEnum("zero_score_reason", [
  "unknown",
  "skipped",
  "irrelevant",
  "incorrect",
]);
export const responseClassificationEnum = pgEnum("response_classification", [
  "relevant",
  "ambiguous",
  "irrelevant",
]);
export const reportKindEnum = pgEnum("report_kind", ["complete", "incomplete"]);
export const messageRoleEnum = pgEnum("interview_message_role", ["user", "assistant", "system"]);
export const messageKindEnum = pgEnum("interview_message_kind", [
  "main_question",
  "main_answer",
  "follow_up_answer",
  "supplement",
  "question_clarification",
  "system_follow_up",
  "transition",
]);
export const answerMaterialKindEnum = pgEnum("answer_material_kind", [
  "main_answer",
  "follow_up_answer",
  "supplement",
]);
export const operationTypeEnum = pgEnum("operation_type", [
  "create_interview",
  "submit_answer",
  "submit_supplement",
  "request_question_clarification",
  "mark_question_unknown",
  "skip_question",
  "continue_interview",
  "end_interview_early",
  "abandon_interview",
  "retry_operation",
  "generate_report",
]);
export const operationStatusEnum = pgEnum("operation_status", [
  "pending",
  "processing",
  "succeeded",
  "failed",
]);
export const pendingInterviewOperationKindEnum = pgEnum("pending_interview_operation_kind", [
  "answer_analysis",
  "question_clarification",
]);
export const deletionScopeEnum = pgEnum("deletion_scope", ["account", "interview"]);
export const deletionStatusEnum = pgEnum("deletion_status", [
  "pending",
  "processing",
  "completed",
  "failed",
]);
export const purgeDataCategoryEnum = pgEnum("purge_data_category", [
  "account",
  "authentication",
  "interview",
  "message",
  "evaluation",
  "operation",
  "report",
]);
export const purgeResultEnum = pgEnum("purge_result", ["succeeded", "failed"]);

export const interviewSessions = pgTable(
  "interview_sessions",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    direction: interviewDirectionEnum("direction").default("go_backend").notNull(),
    selectedQuestionCount: smallint("selected_question_count")
      .$type<InterviewQuestionCount>()
      .notNull(),
    selectionSeed: text("selection_seed").notNull(),
    status: interviewStatusEnum("status").$type<InterviewStatus>().default("active").notNull(),
    activePhase: interviewPhaseEnum("active_phase")
      .$type<InterviewPhase>()
      .default("awaiting_response"),
    version: integer("version").default(1).notNull(),
    currentQuestionPosition: smallint("current_question_position").default(1).notNull(),
    pendingOperationId: text("pending_operation_id"),
    pendingOperationKind: pendingInterviewOperationKindEnum("pending_operation_kind"),
    pendingOperationQuestionPosition: smallint("pending_operation_question_position"),
    pendingOperationAcceptedAt: timestamp("pending_operation_accepted_at", {
      withTimezone: true,
    }),
    pendingOperationPreviousPhase: interviewPhaseEnum("pending_operation_previous_phase"),
    pendingReportKind: reportKindEnum("pending_report_kind").$type<ReportKind>(),
    reportRequestedAt: timestamp("report_requested_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastEffectiveActivityAt: timestamp("last_effective_activity_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    deletionRequestedAt: timestamp("deletion_requested_at", { withTimezone: true }),
  },
  (table) => [
    unique("interview_sessions_id_owner_fk_target_unique").on(table.id, table.ownerUserId),
    uniqueIndex("interview_sessions_one_open_per_user_idx")
      .on(table.ownerUserId)
      .where(sql`${table.status} in ('active', 'report_pending')`),
    index("interview_sessions_owner_user_idx").on(table.ownerUserId),
    index("interview_sessions_status_idx").on(table.status),
    index("interview_sessions_last_activity_idx").on(table.lastEffectiveActivityAt),
    check(
      "interview_sessions_selected_question_count_check",
      sql`${table.selectedQuestionCount} in (5, 10, 15)`,
    ),
    check("interview_sessions_version_check", sql`${table.version} >= 1`),
    check(
      "interview_sessions_current_position_check",
      sql`${table.currentQuestionPosition} between 1 and ${table.selectedQuestionCount}`,
    ),
    check(
      "interview_sessions_pending_operation_check",
      sql`
        (
          ${table.activePhase} is distinct from 'processing'
          and ${table.pendingOperationId} is null
          and ${table.pendingOperationKind} is null
          and ${table.pendingOperationQuestionPosition} is null
          and ${table.pendingOperationAcceptedAt} is null
          and ${table.pendingOperationPreviousPhase} is null
        )
        or (
          ${table.status} = 'active'
          and ${table.activePhase} = 'processing'
          and ${table.pendingOperationId} is not null
          and ${table.pendingOperationKind} is not null
          and ${table.pendingOperationQuestionPosition} is not null
          and ${table.pendingOperationAcceptedAt} is not null
          and ${table.pendingOperationPreviousPhase} in ('awaiting_response', 'awaiting_continue')
        )
      `,
    ),
  ],
);

export const questionBankVersions = pgTable(
  "question_bank_versions",
  {
    questionId: text("question_id").notNull(),
    contentVersion: integer("content_version").notNull(),
    domain: knowledgeDomainEnum("domain").$type<KnowledgeDomain>().notNull(),
    difficulty: questionDifficultyEnum("difficulty").default("medium").notNull(),
    sourceWording: text("source_wording").notNull(),
    rubric: jsonb("rubric").$type<readonly RubricItemSnapshot[]>().notNull(),
    followUpGoals: jsonb("follow_up_goals").$type<readonly FollowUpGoalSnapshot[]>().notNull(),
    knowledgeExplanation: text("knowledge_explanation").notNull(),
    active: boolean("active").default(false).notNull(),
    reviewed: boolean("reviewed").default(false).notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: text("reviewed_by"),
    importSourceName: text("import_source_name").notNull(),
    importSourceVersion: integer("import_source_version").notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      name: "question_bank_versions_pk",
      columns: [table.questionId, table.contentVersion],
    }),
    index("question_bank_versions_domain_idx").on(table.domain),
    index("question_bank_versions_active_reviewed_idx").on(table.active, table.reviewed),
    check("question_bank_versions_content_version_check", sql`${table.contentVersion} >= 1`),
  ],
);

export const sessionQuestionSnapshots = pgTable(
  "session_question_snapshots",
  {
    id: text("id").primaryKey(),
    interviewId: text("interview_id")
      .notNull()
      .references(() => interviewSessions.id, { onDelete: "cascade" }),
    position: smallint("position").notNull(),
    sourceQuestionId: text("source_question_id").notNull(),
    sourceQuestionVersion: integer("source_question_version").notNull(),
    domain: knowledgeDomainEnum("domain").$type<KnowledgeDomain>().notNull(),
    sourceWording: text("source_wording").notNull(),
    displayWording: text("display_wording").notNull(),
    rubric: jsonb("rubric").$type<readonly RubricItemSnapshot[]>().notNull(),
    followUpGoals: jsonb("follow_up_goals").$type<readonly FollowUpGoalSnapshot[]>().notNull(),
    knowledgeExplanation: text("knowledge_explanation").notNull(),
    frozen: boolean("frozen").default(false).notNull(),
    outcomeKind: questionOutcomeKindEnum("outcome_kind").$type<QuestionOutcomeKind>(),
    score: smallint("score"),
    zeroScoreReason: zeroScoreReasonEnum("zero_score_reason").$type<ZeroScoreReason>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    frozenAt: timestamp("frozen_at", { withTimezone: true }),
  },
  (table) => [
    unique("session_question_snapshots_id_interview_fk_target_unique").on(
      table.id,
      table.interviewId,
    ),
    unique("session_question_snapshots_interview_position_unique").on(
      table.interviewId,
      table.position,
    ),
    index("session_question_snapshots_interview_idx").on(table.interviewId),
    index("session_question_snapshots_source_idx").on(
      table.sourceQuestionId,
      table.sourceQuestionVersion,
    ),
    foreignKey({
      name: "session_question_snapshots_source_question_fk",
      columns: [table.sourceQuestionId, table.sourceQuestionVersion],
      foreignColumns: [questionBankVersions.questionId, questionBankVersions.contentVersion],
    }).onDelete("restrict"),
    check("session_question_snapshots_position_check", sql`${table.position} >= 1`),
    check(
      "session_question_snapshots_source_version_check",
      sql`${table.sourceQuestionVersion} >= 1`,
    ),
    check(
      "session_question_snapshots_outcome_integrity_check",
      sql`
        (
          (${table.outcomeKind} is null and ${table.score} is null and ${table.zeroScoreReason} is null)
          or (
            ${table.outcomeKind} = 'scored'
            and ${table.score} between 1 and 100
            and ${table.zeroScoreReason} is null
          )
          or (
            ${table.outcomeKind} = 'incorrect'
            and ${table.score} = 0
            and ${table.zeroScoreReason} = 'incorrect'
          )
          or (
            ${table.outcomeKind} = 'irrelevant'
            and ${table.score} = 0
            and ${table.zeroScoreReason} = 'irrelevant'
          )
          or (
            ${table.outcomeKind} = 'unknown'
            and ${table.score} = 0
            and ${table.zeroScoreReason} = 'unknown'
          )
          or (
            ${table.outcomeKind} = 'skipped'
            and ${table.score} = 0
            and ${table.zeroScoreReason} = 'skipped'
          )
        ) is true
      `,
    ),
  ],
);

export const operations = pgTable(
  "operations",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    interviewId: text("interview_id").notNull(),
    idempotencyScope: text("idempotency_scope").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    type: operationTypeEnum("type").notNull(),
    status: operationStatusEnum("status").default("pending").notNull(),
    expectedVersion: integer("expected_version").notNull(),
    inputHash: text("input_hash").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    leaseAcquiredAt: timestamp("lease_acquired_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    leaseOwner: text("lease_owner"),
    leaseTokenHash: text("lease_token_hash"),
    completedLeaseOwner: text("completed_lease_owner"),
    completedLeaseTokenHash: text("completed_lease_token_hash"),
    retryable: boolean("retryable").default(false).notNull(),
    input: jsonb("input").$type<JsonObject>().notNull(),
    result: jsonb("result").$type<JsonObject>(),
    error: jsonb("error").$type<JsonObject>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique("operations_id_interview_fk_target_unique").on(table.id, table.interviewId),
    unique("operations_owner_scope_idempotency_unique").on(
      table.ownerUserId,
      table.idempotencyScope,
      table.idempotencyKey,
    ),
    index("operations_owner_user_idx").on(table.ownerUserId),
    index("operations_interview_idx").on(table.interviewId),
    index("operations_status_lease_idx").on(table.status, table.leaseExpiresAt),
    foreignKey({
      name: "operations_interview_owner_fk",
      columns: [table.interviewId, table.ownerUserId],
      foreignColumns: [interviewSessions.id, interviewSessions.ownerUserId],
    }).onDelete("cascade"),
    check("operations_expected_version_check", sql`${table.expectedVersion} >= 0`),
    check("operations_attempt_count_check", sql`${table.attemptCount} >= 0`),
    check(
      "operations_identity_hash_check",
      sql`
        length(trim(${table.idempotencyScope})) > 0
        and length(${table.inputHash}) = 64
      `,
    ),
    check(
      "operations_lifecycle_check",
      sql`
        (
          ${table.status} = 'processing'
          and ${table.leaseAcquiredAt} is not null
          and ${table.leaseExpiresAt} is not null
          and ${table.leaseOwner} is not null
          and ${table.leaseTokenHash} is not null
          and length(trim(${table.leaseOwner})) > 0
          and length(${table.leaseTokenHash}) = 64
          and ${table.leaseExpiresAt} > ${table.leaseAcquiredAt}
          and ${table.result} is null
          and ${table.error} is null
          and ${table.completedAt} is null
          and ${table.completedLeaseOwner} is null
          and ${table.completedLeaseTokenHash} is null
          and ${table.retryable} = false
        )
        or (
          ${table.status} = 'pending'
          and ${table.leaseAcquiredAt} is null
          and ${table.leaseExpiresAt} is null
          and ${table.leaseOwner} is null
          and ${table.leaseTokenHash} is null
          and ${table.completedLeaseOwner} is null
          and ${table.completedLeaseTokenHash} is null
          and ${table.result} is null
          and ${table.error} is null
          and ${table.completedAt} is null
          and ${table.retryable} = false
        )
        or (
          ${table.status} = 'succeeded'
          and ${table.leaseAcquiredAt} is null
          and ${table.leaseExpiresAt} is null
          and ${table.leaseOwner} is null
          and ${table.leaseTokenHash} is null
          and ${table.completedLeaseOwner} is not null
          and ${table.completedLeaseTokenHash} is not null
          and length(trim(${table.completedLeaseOwner})) > 0
          and length(${table.completedLeaseTokenHash}) = 64
          and ${table.result} is not null
          and ${table.error} is null
          and ${table.completedAt} is not null
          and ${table.retryable} = false
        )
        or (
          ${table.status} = 'failed'
          and ${table.leaseAcquiredAt} is null
          and ${table.leaseExpiresAt} is null
          and ${table.leaseOwner} is null
          and ${table.leaseTokenHash} is null
          and ${table.completedLeaseOwner} is not null
          and ${table.completedLeaseTokenHash} is not null
          and length(trim(${table.completedLeaseOwner})) > 0
          and length(${table.completedLeaseTokenHash}) = 64
          and ${table.result} is null
          and ${table.error} is not null
          and ${table.completedAt} is not null
        )
      `,
    ),
  ],
);

export const interviewMessages = pgTable(
  "interview_messages",
  {
    id: text("id").primaryKey(),
    interviewId: text("interview_id").notNull(),
    sequence: integer("sequence").notNull(),
    questionSnapshotId: text("question_snapshot_id"),
    questionPosition: smallint("question_position"),
    role: messageRoleEnum("role").notNull(),
    kind: messageKindEnum("kind").notNull(),
    answerMaterialKind: answerMaterialKindEnum("answer_material_kind").$type<AnswerMaterialKind>(),
    content: text("content").notNull(),
    operationId: text("operation_id"),
    metadata: jsonb("metadata").$type<JsonObject>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("interview_messages_interview_sequence_unique").on(table.interviewId, table.sequence),
    index("interview_messages_interview_position_idx").on(
      table.interviewId,
      table.questionPosition,
    ),
    index("interview_messages_operation_idx").on(table.operationId),
    foreignKey({
      name: "interview_messages_interview_fk",
      columns: [table.interviewId],
      foreignColumns: [interviewSessions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "interview_messages_snapshot_aggregate_fk",
      columns: [table.questionSnapshotId, table.interviewId],
      foreignColumns: [sessionQuestionSnapshots.id, sessionQuestionSnapshots.interviewId],
    }).onDelete("cascade"),
    foreignKey({
      name: "interview_messages_operation_aggregate_fk",
      columns: [table.operationId, table.interviewId],
      foreignColumns: [operations.id, operations.interviewId],
    }),
    check(
      "interview_messages_question_position_check",
      sql`${table.questionPosition} is null or ${table.questionPosition} >= 1`,
    ),
    check("interview_messages_sequence_check", sql`${table.sequence} > 0`),
  ],
);

export const questionEvaluations = pgTable(
  "question_evaluations",
  {
    id: text("id").primaryKey(),
    questionSnapshotId: text("question_snapshot_id")
      .notNull()
      .references(() => sessionQuestionSnapshots.id, { onDelete: "cascade" }),
    classification: responseClassificationEnum("classification")
      .$type<ResponseClassification>()
      .notNull(),
    rubricResults: jsonb("rubric_results").$type<readonly RubricItemEvaluation[]>().notNull(),
    outcomeKind: evaluationOutcomeKindEnum("outcome_kind")
      .$type<Exclude<QuestionOutcomeKind, "unknown" | "skipped">>()
      .notNull(),
    score: smallint("score").notNull(),
    zeroScoreReason: zeroScoreReasonEnum("zero_score_reason").$type<ZeroScoreReason>(),
    modelMetadata: jsonb("model_metadata").$type<ModelCallMetadata>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("question_evaluations_snapshot_unique").on(table.questionSnapshotId),
    check(
      "question_evaluations_outcome_integrity_check",
      sql`
        (
          (
            ${table.outcomeKind} = 'scored'
            and ${table.classification} in ('relevant', 'ambiguous')
            and ${table.score} between 1 and 100
            and ${table.zeroScoreReason} is null
          )
          or (
            ${table.outcomeKind} = 'incorrect'
            and ${table.classification} in ('relevant', 'ambiguous')
            and ${table.score} = 0
            and ${table.zeroScoreReason} = 'incorrect'
          )
          or (
            ${table.outcomeKind} = 'irrelevant'
            and ${table.classification} = 'irrelevant'
            and ${table.score} = 0
            and ${table.zeroScoreReason} = 'irrelevant'
          )
        ) is true
      `,
    ),
  ],
);

export const reports = pgTable(
  "reports",
  {
    id: text("id").primaryKey(),
    interviewId: text("interview_id").notNull(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    kind: reportKindEnum("kind").$type<ReportKind>().notNull(),
    schemaVersion: text("schema_version").notNull(),
    snapshot: jsonb("snapshot").$type<ImmutableReportSnapshot>().notNull(),
    modelMetadata: jsonb("model_metadata").$type<ModelCallMetadata>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("reports_interview_unique").on(table.interviewId),
    index("reports_owner_user_idx").on(table.ownerUserId),
    foreignKey({
      name: "reports_interview_owner_fk",
      columns: [table.interviewId, table.ownerUserId],
      foreignColumns: [interviewSessions.id, interviewSessions.ownerUserId],
    }).onDelete("cascade"),
  ],
);

export const deletionRequests = pgTable(
  "deletion_requests",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    scope: deletionScopeEnum("scope").notNull(),
    interviewId: text("interview_id"),
    status: deletionStatusEnum("status").default("pending").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
    inaccessibleAt: timestamp("inaccessible_at", { withTimezone: true }).defaultNow().notNull(),
    purgeDueAt: timestamp("purge_due_at", { withTimezone: true }).notNull(),
    purgeDeadlineAt: timestamp("purge_deadline_at", { withTimezone: true }).notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    leaseOwner: text("lease_owner"),
    leaseTokenHash: text("lease_token_hash"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastErrorCategory: text("last_error_category"),
    lastErrorCode: text("last_error_code"),
  },
  (table) => [
    index("deletion_requests_owner_user_idx").on(table.ownerUserId),
    index("deletion_requests_interview_idx").on(table.interviewId),
    index("deletion_requests_status_due_idx").on(
      table.status,
      table.purgeDueAt,
      table.leaseExpiresAt,
    ),
    uniqueIndex("deletion_requests_one_account_request_idx")
      .on(table.ownerUserId)
      .where(sql`${table.scope} = 'account'`),
    uniqueIndex("deletion_requests_one_interview_request_idx")
      .on(table.interviewId)
      .where(sql`${table.scope} = 'interview'`),
    foreignKey({
      name: "deletion_requests_interview_owner_fk",
      columns: [table.interviewId, table.ownerUserId],
      foreignColumns: [interviewSessions.id, interviewSessions.ownerUserId],
    }).onDelete("restrict"),
    check(
      "deletion_requests_purge_window_check",
      sql`
        ${table.purgeDueAt} >= ${table.requestedAt}
        and ${table.purgeDueAt} < ${table.purgeDeadlineAt}
        and ${table.purgeDeadlineAt} = ${table.requestedAt} + interval '7 days'
      `,
    ),
    check(
      "deletion_requests_scope_target_check",
      sql`(${table.scope} = 'account' and ${table.interviewId} is null) or (${table.scope} = 'interview' and ${table.interviewId} is not null)`,
    ),
    check("deletion_requests_attempt_count_check", sql`${table.attemptCount} >= 0`),
    check(
      "deletion_requests_error_bounds_check",
      sql`
        (
          ${table.lastErrorCategory} is null
          and ${table.lastErrorCode} is null
        )
        or (
          length(${table.lastErrorCategory}) between 1 and 32
          and ${table.lastErrorCategory} ~ '^[a-z0-9_]+$'
          and length(${table.lastErrorCode}) between 1 and 64
          and ${table.lastErrorCode} ~ '^[a-z0-9_]+$'
        )
      `,
    ),
    check(
      "deletion_requests_lifecycle_check",
      sql`
        (
          ${table.status} = 'processing'
          and ${table.processingStartedAt} is not null
          and ${table.lastAttemptAt} is not null
          and ${table.leaseExpiresAt} is not null
          and ${table.leaseOwner} is not null
          and ${table.leaseTokenHash} is not null
          and length(trim(${table.leaseOwner})) > 0
          and length(${table.leaseTokenHash}) = 64
          and ${table.leaseExpiresAt} > ${table.processingStartedAt}
          and ${table.completedAt} is null
          and ${table.lastErrorCategory} is null
          and ${table.lastErrorCode} is null
        )
        or (
          ${table.status} in ('pending', 'failed')
          and ${table.processingStartedAt} is null
          and ${table.leaseExpiresAt} is null
          and ${table.leaseOwner} is null
          and ${table.leaseTokenHash} is null
          and ${table.completedAt} is null
          and (
            (${table.status} = 'pending' and ${table.lastErrorCategory} is null and ${table.lastErrorCode} is null)
            or
            (${table.status} = 'failed' and ${table.lastErrorCategory} is not null and ${table.lastErrorCode} is not null)
          )
        )
        or (
          ${table.status} = 'completed'
          and ${table.processingStartedAt} is null
          and ${table.leaseExpiresAt} is null
          and ${table.leaseOwner} is null
          and ${table.leaseTokenHash} is null
          and ${table.completedAt} is not null
          and ${table.lastErrorCategory} is null
          and ${table.lastErrorCode} is null
        )
      `,
    ),
  ],
);

export const purgeAuditEvents = pgTable(
  "purge_audit_events",
  {
    subjectIdentifierHash: text("subject_identifier_hash").notNull(),
    dataCategory: purgeDataCategoryEnum("data_category").notNull(),
    result: purgeResultEnum("result").notNull(),
    purgedAt: timestamp("purged_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "purge_audit_events_pk",
      columns: [table.subjectIdentifierHash, table.dataCategory, table.purgedAt],
    }),
    index("purge_audit_events_subject_hash_idx").on(table.subjectIdentifierHash),
    index("purge_audit_events_purged_at_idx").on(table.purgedAt),
    check(
      "purge_audit_events_subject_hash_check",
      sql`length(${table.subjectIdentifierHash}) = 64 and ${table.subjectIdentifierHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const interviewSessionRelations = relations(interviewSessions, ({ many, one }) => ({
  owner: one(user, {
    fields: [interviewSessions.ownerUserId],
    references: [user.id],
  }),
  questions: many(sessionQuestionSnapshots),
  messages: many(interviewMessages),
  operations: many(operations, { relationName: "interviewOperations" }),
  reports: many(reports, { relationName: "interviewReports" }),
  deletionRequests: many(deletionRequests),
}));

export const questionBankVersionRelations = relations(questionBankVersions, ({ many }) => ({
  sessionSnapshots: many(sessionQuestionSnapshots, {
    relationName: "sourceQuestionVersion",
  }),
}));

export const sessionQuestionSnapshotRelations = relations(
  sessionQuestionSnapshots,
  ({ many, one }) => ({
    interview: one(interviewSessions, {
      fields: [sessionQuestionSnapshots.interviewId],
      references: [interviewSessions.id],
    }),
    sourceQuestionVersion: one(questionBankVersions, {
      fields: [
        sessionQuestionSnapshots.sourceQuestionId,
        sessionQuestionSnapshots.sourceQuestionVersion,
      ],
      references: [questionBankVersions.questionId, questionBankVersions.contentVersion],
      relationName: "sourceQuestionVersion",
    }),
    messages: many(interviewMessages),
    evaluations: many(questionEvaluations, { relationName: "snapshotEvaluations" }),
  }),
);

export const interviewMessageRelations = relations(interviewMessages, ({ one }) => ({
  interview: one(interviewSessions, {
    fields: [interviewMessages.interviewId],
    references: [interviewSessions.id],
  }),
  questionSnapshot: one(sessionQuestionSnapshots, {
    fields: [interviewMessages.questionSnapshotId, interviewMessages.interviewId],
    references: [sessionQuestionSnapshots.id, sessionQuestionSnapshots.interviewId],
  }),
  operation: one(operations, {
    fields: [interviewMessages.operationId, interviewMessages.interviewId],
    references: [operations.id, operations.interviewId],
  }),
}));

export const operationRelations = relations(operations, ({ many, one }) => ({
  owner: one(user, {
    fields: [operations.ownerUserId],
    references: [user.id],
  }),
  interview: one(interviewSessions, {
    fields: [operations.interviewId],
    references: [interviewSessions.id],
    relationName: "interviewOperations",
  }),
  messages: many(interviewMessages),
}));

export const questionEvaluationRelations = relations(questionEvaluations, ({ one }) => ({
  questionSnapshot: one(sessionQuestionSnapshots, {
    fields: [questionEvaluations.questionSnapshotId],
    references: [sessionQuestionSnapshots.id],
    relationName: "snapshotEvaluations",
  }),
}));

export const reportRelations = relations(reports, ({ one }) => ({
  interview: one(interviewSessions, {
    fields: [reports.interviewId],
    references: [interviewSessions.id],
    relationName: "interviewReports",
  }),
  owner: one(user, {
    fields: [reports.ownerUserId],
    references: [user.id],
  }),
}));

export const deletionRequestRelations = relations(deletionRequests, ({ one }) => ({
  owner: one(user, {
    fields: [deletionRequests.ownerUserId],
    references: [user.id],
  }),
  interview: one(interviewSessions, {
    fields: [deletionRequests.interviewId],
    references: [interviewSessions.id],
  }),
}));

export type InterviewSession = typeof interviewSessions.$inferSelect;
export type NewInterviewSession = typeof interviewSessions.$inferInsert;
export type QuestionBankVersion = typeof questionBankVersions.$inferSelect;
export type NewQuestionBankVersion = typeof questionBankVersions.$inferInsert;
export type SessionQuestionSnapshot = typeof sessionQuestionSnapshots.$inferSelect;
export type NewSessionQuestionSnapshot = typeof sessionQuestionSnapshots.$inferInsert;
export type InterviewMessage = typeof interviewMessages.$inferSelect;
export type NewInterviewMessage = typeof interviewMessages.$inferInsert;
export type Operation = typeof operations.$inferSelect;
export type NewOperation = typeof operations.$inferInsert;
export type QuestionEvaluationRecord = typeof questionEvaluations.$inferSelect;
export type NewQuestionEvaluationRecord = typeof questionEvaluations.$inferInsert;
export type Report = typeof reports.$inferSelect;
export type NewReport = typeof reports.$inferInsert;
export type DeletionRequest = typeof deletionRequests.$inferSelect;
export type NewDeletionRequest = typeof deletionRequests.$inferInsert;
export type PurgeAuditEvent = typeof purgeAuditEvents.$inferSelect;
export type NewPurgeAuditEvent = typeof purgeAuditEvents.$inferInsert;
