import type {
  ModelCallMetadata,
  RubricItemEvaluation,
  RubricItemSnapshot,
} from "@interview-agent/domain";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  account,
  deletionRequests,
  interviewMessages,
  interviewSessions,
  type NewQuestionBankVersion,
  type NewQuestionEvaluationRecord,
  operations,
  purgeAuditEvents,
  questionBankVersions,
  questionEvaluations,
  reports,
  session,
  sessionQuestionSnapshots,
} from "../src/schema/index.js";

const businessTables = [
  interviewSessions,
  questionBankVersions,
  sessionQuestionSnapshots,
  interviewMessages,
  operations,
  questionEvaluations,
  reports,
  deletionRequests,
  purgeAuditEvents,
] as const;

function columnNames(table: PgTable): string[] {
  return getTableConfig(table).columns.map((column) => column.name);
}

function indexNames(table: PgTable): string[] {
  return getTableConfig(table).indexes.map((item) => item.config.name);
}

function uniqueConstraintNames(table: PgTable): string[] {
  return getTableConfig(table).uniqueConstraints.map((item) => item.getName() ?? "");
}

function foreignKey(
  table: PgTable,
  columnName: string,
): { foreignTable: string; onDelete: string | undefined } {
  const key = getTableConfig(table).foreignKeys.find(
    (candidate) => candidate.reference().columns[0]?.name === columnName,
  );
  if (key === undefined) {
    throw new Error(`Missing foreign key for ${getTableConfig(table).name}.${columnName}`);
  }

  return {
    foreignTable: getTableConfig(key.reference().foreignTable).name,
    onDelete: key.onDelete,
  };
}

function foreignKeyByName(
  table: PgTable,
  name: string,
): {
  columns: string[];
  foreignColumns: string[];
  foreignTable: string;
  onDelete: string | undefined;
} {
  const key = getTableConfig(table).foreignKeys.find((candidate) => candidate.getName() === name);
  if (key === undefined) {
    throw new Error(`Missing foreign key ${name}`);
  }
  const reference = key.reference();

  return {
    columns: reference.columns.map((column) => column.name),
    foreignColumns: reference.foreignColumns.map((column) => column.name),
    foreignTable: getTableConfig(reference.foreignTable).name,
    onDelete: key.onDelete,
  };
}

describe("interview persistence PostgreSQL schema", () => {
  it("exports every task 3.2 table with stable SQL names", () => {
    expect(businessTables.map((table) => getTableConfig(table).name)).toEqual([
      "interview_sessions",
      "question_bank_versions",
      "session_question_snapshots",
      "interview_messages",
      "operations",
      "question_evaluations",
      "reports",
      "deletion_requests",
      "purge_audit_events",
    ]);
  });

  it("stores the complete interview aggregate lifecycle", () => {
    expect(columnNames(interviewSessions)).toEqual([
      "id",
      "owner_user_id",
      "direction",
      "selected_question_count",
      "selection_seed",
      "status",
      "active_phase",
      "version",
      "current_question_position",
      "pending_operation_kind",
      "pending_operation_question_position",
      "pending_operation_accepted_at",
      "pending_operation_previous_phase",
      "pending_report_kind",
      "report_requested_at",
      "created_at",
      "last_effective_activity_at",
      "ended_at",
      "deletion_requested_at",
    ]);
    expect(interviewSessions.id.columnType).toBe("PgText");
    expect(interviewSessions.direction.default).toBe("go_backend");
    expect(interviewSessions.direction.enumValues).toEqual(["go_backend"]);
    expect(interviewSessions.status.default).toBe("active");
    expect(interviewSessions.status.enumValues).toEqual([
      "active",
      "report_pending",
      "completed",
      "early_ended",
      "abandoned",
      "deleting",
    ]);
    expect(interviewSessions.activePhase.default).toBe("awaiting_response");
    expect(interviewSessions.activePhase.notNull).toBe(false);
    expect(interviewSessions.version.default).toBe(1);
    expect(interviewSessions.currentQuestionPosition.default).toBe(1);
  });

  it("uses domain-typed JSONB for frozen content and structured model facts", () => {
    const expectedJsonColumns = new Map<PgTable, readonly string[]>([
      [questionBankVersions, ["rubric", "follow_up_goals"]],
      [sessionQuestionSnapshots, ["rubric", "follow_up_goals"]],
      [interviewMessages, ["metadata"]],
      [operations, ["input", "result", "error"]],
      [questionEvaluations, ["rubric_results", "model_metadata"]],
      [reports, ["snapshot", "model_metadata"]],
      [deletionRequests, ["result", "error"]],
      [purgeAuditEvents, []],
    ]);

    for (const [table, names] of expectedJsonColumns) {
      const jsonColumns = getTableConfig(table)
        .columns.filter((column) => column.columnType === "PgJsonb")
        .map((column) => column.name);
      expect(jsonColumns).toEqual(names);
    }

    expectTypeOf<NewQuestionBankVersion["rubric"]>().toEqualTypeOf<readonly RubricItemSnapshot[]>();
    expectTypeOf<NewQuestionEvaluationRecord["rubricResults"]>().toEqualTypeOf<
      readonly RubricItemEvaluation[]
    >();
    expectTypeOf<NewQuestionEvaluationRecord["modelMetadata"]>().toEqualTypeOf<ModelCallMetadata>();
  });

  it("adds only composite-FK support keys while task 3.3 uniqueness remains deferred", () => {
    expect(indexNames(interviewSessions)).toEqual([
      "interview_sessions_owner_user_idx",
      "interview_sessions_status_idx",
      "interview_sessions_last_activity_idx",
    ]);
    expect(indexNames(sessionQuestionSnapshots)).toEqual([
      "session_question_snapshots_interview_idx",
      "session_question_snapshots_source_idx",
    ]);
    expect(indexNames(operations)).toEqual([
      "operations_owner_user_idx",
      "operations_interview_idx",
      "operations_status_lease_idx",
    ]);

    for (const table of [interviewSessions, sessionQuestionSnapshots, operations]) {
      expect(getTableConfig(table).indexes.every((item) => !item.config.unique)).toBe(true);
    }
    expect(uniqueConstraintNames(interviewSessions)).toEqual([
      "interview_sessions_id_owner_fk_target_unique",
    ]);
    expect(uniqueConstraintNames(sessionQuestionSnapshots)).toEqual([
      "session_question_snapshots_id_interview_fk_target_unique",
    ]);
    expect(uniqueConstraintNames(operations)).toEqual(["operations_id_interview_fk_target_unique"]);

    expect(
      getTableConfig(interviewSessions).indexes.some(
        (item) => item.config.unique && item.config.where !== undefined,
      ),
    ).toBe(false);
    expect(
      getTableConfig(sessionQuestionSnapshots).uniqueConstraints.some((constraint) =>
        constraint.columns.some((column) => column.name === "position"),
      ),
    ).toBe(false);
    expect(
      getTableConfig(operations).uniqueConstraints.some((constraint) =>
        constraint.columns.some((column) => column.name === "idempotency_key"),
      ),
    ).toBe(false);
  });

  it("scopes duplicated owner and aggregate IDs through composite foreign keys", () => {
    expect(foreignKey(interviewSessions, "owner_user_id")).toEqual({
      foreignTable: "user",
      onDelete: "restrict",
    });
    expect(foreignKey(operations, "owner_user_id")).toEqual({
      foreignTable: "user",
      onDelete: "restrict",
    });
    expect(foreignKey(reports, "owner_user_id")).toEqual({
      foreignTable: "user",
      onDelete: "restrict",
    });
    expect(foreignKey(deletionRequests, "owner_user_id")).toEqual({
      foreignTable: "user",
      onDelete: "restrict",
    });
    expect(foreignKeyByName(operations, "operations_interview_owner_fk")).toEqual({
      columns: ["interview_id", "owner_user_id"],
      foreignColumns: ["id", "owner_user_id"],
      foreignTable: "interview_sessions",
      onDelete: "cascade",
    });
    expect(foreignKeyByName(reports, "reports_interview_owner_fk")).toEqual({
      columns: ["interview_id", "owner_user_id"],
      foreignColumns: ["id", "owner_user_id"],
      foreignTable: "interview_sessions",
      onDelete: "cascade",
    });
    expect(foreignKeyByName(deletionRequests, "deletion_requests_interview_owner_fk")).toEqual({
      columns: ["interview_id", "owner_user_id"],
      foreignColumns: ["id", "owner_user_id"],
      foreignTable: "interview_sessions",
      onDelete: "restrict",
    });
    expect(foreignKeyByName(interviewMessages, "interview_messages_snapshot_aggregate_fk")).toEqual(
      {
        columns: ["question_snapshot_id", "interview_id"],
        foreignColumns: ["id", "interview_id"],
        foreignTable: "session_question_snapshots",
        onDelete: "cascade",
      },
    );
    expect(
      foreignKeyByName(interviewMessages, "interview_messages_operation_aggregate_fk"),
    ).toEqual({
      columns: ["operation_id", "interview_id"],
      foreignColumns: ["id", "interview_id"],
      foreignTable: "operations",
      onDelete: "no action",
    });
    expect(foreignKey(sessionQuestionSnapshots, "source_question_id")).toEqual({
      foreignTable: "question_bank_versions",
      onDelete: "restrict",
    });

    expect(foreignKey(account, "user_id").onDelete).toBe("cascade");
    expect(foreignKey(session, "user_id").onDelete).toBe("cascade");
  });

  it("derives aggregate children without cyclic report or evaluation pointers", () => {
    expect(columnNames(interviewSessions)).not.toContain("report_id");
    expect(columnNames(interviewSessions)).not.toContain("pending_operation_id");
    expect(columnNames(sessionQuestionSnapshots)).not.toContain("current_evaluation_id");
    expect(columnNames(questionEvaluations)).not.toContain("interview_id");
    expect(columnNames(questionEvaluations)).not.toContain("operation_id");
    expect(indexNames(reports)).toContain("reports_interview_idx");
    expect(indexNames(questionEvaluations)).toContain("question_evaluations_snapshot_idx");
  });

  it("uses timestamptz for every business absolute instant", () => {
    const timestampColumns = businessTables.flatMap((table) =>
      getTableConfig(table).columns.filter((column) => column.columnType === "PgTimestamp"),
    );

    expect(timestampColumns.length).toBeGreaterThan(0);
    expect(timestampColumns.every((column) => column.withTimezone)).toBe(true);
  });

  it("restricts persisted evaluation outcomes and minimizes purge audit data", () => {
    expect(questionEvaluations.outcomeKind.enumValues).toEqual([
      "scored",
      "incorrect",
      "irrelevant",
    ]);
    expect(columnNames(purgeAuditEvents)).toEqual([
      "subject_identifier_hash",
      "data_category",
      "result",
      "purged_at",
    ]);
  });

  it("stores only final message content and no stream or raw model deltas", () => {
    const allNames = businessTables.flatMap((table) => [
      getTableConfig(table).name,
      ...columnNames(table),
    ]);

    expect(allNames).not.toContain("operation_events");
    expect(
      allNames.filter((name) => /(?:stream|model)_delta|raw_model_(?:text|output)/.test(name)),
    ).toEqual([]);
    expect(interviewMessages.content.notNull).toBe(true);
  });
});
