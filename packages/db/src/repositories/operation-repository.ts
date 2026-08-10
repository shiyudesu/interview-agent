import type { AccountId, OperationId } from "@interview-agent/domain";
import { and, eq, isNull, ne, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import { interviewSessions, operations, user } from "../schema/index.js";
import {
  RepositoryCorruptionError,
  RepositoryImmutableConflictError,
  RepositoryNotFoundError,
} from "./errors.js";
import { RepositoryExecution } from "./transaction.js";
import type {
  CreateOperation,
  OperationResultUpdate,
  OperationType,
  StartProcessingOperation,
  StoredOperation,
} from "./types.js";
import {
  decodeAccountId,
  decodeInterviewId,
  decodeJsonObject,
  decodeOperationId,
  isRecord,
} from "./validation.js";

const accessibleOperation = sql`
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

export class PgOperationRepository {
  private readonly execution: RepositoryExecution;

  constructor(
    database: Database,
    execution: RepositoryExecution = new RepositoryExecution(database),
  ) {
    this.execution = execution;
  }

  async create(operation: CreateOperation): Promise<StoredOperation> {
    if (operation.idempotencyKey.trim().length === 0) {
      throw new RepositoryImmutableConflictError("Operation idempotency key", operation.id);
    }
    try {
      const rows = await this.execution.executor
        .insert(operations)
        .values({
          id: operation.id,
          ownerUserId: operation.accountId,
          interviewId: operation.interviewId,
          idempotencyScope: operation.type,
          idempotencyKey: operation.idempotencyKey,
          type: operation.type,
          status: "pending",
          expectedVersion: operation.expectedVersion,
          input: operation.input,
          createdAt: operation.createdAt,
          updatedAt: operation.createdAt,
        })
        .returning();
      const row = rows[0];
      if (row === undefined) {
        throw new RepositoryNotFoundError("created Operation", operation.id);
      }
      return decodeOperation(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new RepositoryImmutableConflictError("Operation", operation.id, { cause: error });
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
  }

  async findById(operationId: OperationId, accountId: AccountId): Promise<StoredOperation | null> {
    const rows = await this.execution.executor
      .select({ operation: operations })
      .from(operations)
      .innerJoin(interviewSessions, eq(interviewSessions.id, operations.interviewId))
      .innerJoin(user, eq(user.id, operations.ownerUserId))
      .where(
        and(
          eq(operations.id, operationId),
          eq(operations.ownerUserId, accountId),
          ne(interviewSessions.status, "deleting"),
          isNull(interviewSessions.deletionRequestedAt),
          isNull(user.deletionRequestedAt),
          accessibleOperation,
        ),
      )
      .limit(1);
    return rows[0] === undefined ? null : decodeOperation(rows[0]);
  }

  async findByIdempotencyKey(
    accountId: AccountId,
    scope: OperationType,
    idempotencyKey: string,
  ): Promise<StoredOperation | null> {
    const rows = await this.execution.executor
      .select({ operation: operations })
      .from(operations)
      .innerJoin(interviewSessions, eq(interviewSessions.id, operations.interviewId))
      .innerJoin(user, eq(user.id, operations.ownerUserId))
      .where(
        and(
          eq(operations.ownerUserId, accountId),
          eq(operations.idempotencyScope, scope),
          eq(operations.idempotencyKey, idempotencyKey),
          ne(interviewSessions.status, "deleting"),
          isNull(interviewSessions.deletionRequestedAt),
          isNull(user.deletionRequestedAt),
          accessibleOperation,
        ),
      )
      .limit(1);
    return rows[0] === undefined ? null : decodeOperation(rows[0]);
  }

  async startProcessing(update: StartProcessingOperation): Promise<StoredOperation> {
    if (
      !Number.isFinite(update.startedAt.getTime()) ||
      !Number.isFinite(update.leaseExpiresAt.getTime()) ||
      update.leaseExpiresAt.getTime() <= update.startedAt.getTime()
    ) {
      throw new RepositoryImmutableConflictError("Operation processing lease", update.operationId);
    }
    const rows = await this.execution.executor
      .update(operations)
      .set({
        status: "processing",
        attemptCount: sql`${operations.attemptCount} + 1`,
        lastAttemptAt: update.startedAt,
        leaseAcquiredAt: update.startedAt,
        leaseExpiresAt: update.leaseExpiresAt,
        updatedAt: update.startedAt,
      })
      .where(
        and(
          eq(operations.id, update.operationId),
          eq(operations.ownerUserId, update.accountId),
          eq(operations.status, update.expectedStatus),
        ),
      )
      .returning();
    const row = rows[0];
    if (row !== undefined) {
      return decodeOperation(row);
    }
    const existing = await this.findById(update.operationId, update.accountId);
    if (existing === null) {
      throw new RepositoryNotFoundError("Operation", update.operationId);
    }
    throw new RepositoryImmutableConflictError("Operation processing", update.operationId);
  }

  async updateResult(update: OperationResultUpdate): Promise<StoredOperation> {
    const rows = await this.execution.executor
      .update(operations)
      .set(
        update.status === "succeeded"
          ? {
              status: "succeeded",
              result: update.result,
              error: null,
              leaseAcquiredAt: null,
              leaseExpiresAt: null,
              completedAt: update.completedAt,
              updatedAt: update.completedAt,
            }
          : {
              status: "failed",
              result: null,
              error: update.error,
              leaseAcquiredAt: null,
              leaseExpiresAt: null,
              completedAt: update.completedAt,
              updatedAt: update.completedAt,
            },
      )
      .where(
        and(
          eq(operations.id, update.operationId),
          eq(operations.ownerUserId, update.accountId),
          eq(operations.status, update.expectedStatus),
        ),
      )
      .returning();
    const row = rows[0];
    if (row !== undefined) {
      return decodeOperation(row);
    }
    const existing = await this.findById(update.operationId, update.accountId);
    if (existing === null) {
      throw new RepositoryNotFoundError("Operation", update.operationId);
    }
    throw new RepositoryImmutableConflictError("Operation result", update.operationId);
  }
}

function decodeOperation(
  row: { readonly operation: typeof operations.$inferSelect } | typeof operations.$inferSelect,
): StoredOperation {
  const operation = "operation" in row ? row.operation : row;
  if (
    operation.idempotencyScope !== operation.type ||
    operation.idempotencyKey.trim().length === 0 ||
    operation.expectedVersion < 0 ||
    !Number.isInteger(operation.expectedVersion) ||
    operation.attemptCount < 0 ||
    !Number.isInteger(operation.attemptCount)
  ) {
    throw new RepositoryCorruptionError(
      "Operation",
      operation.id,
      "identity or counters are invalid",
    );
  }
  const result =
    operation.result === null
      ? null
      : decodeJsonObject(operation.result, "Operation", operation.id, "result");
  const error =
    operation.error === null
      ? null
      : decodeJsonObject(operation.error, "Operation", operation.id, "error");
  const isProcessing = operation.status === "processing";
  if (
    isProcessing !== (operation.leaseAcquiredAt !== null && operation.leaseExpiresAt !== null) ||
    (operation.status === "succeeded" &&
      (result === null || error !== null || operation.completedAt === null)) ||
    (operation.status === "failed" &&
      (error === null || result !== null || operation.completedAt === null)) ||
    ((operation.status === "pending" || operation.status === "processing") &&
      operation.completedAt !== null)
  ) {
    throw new RepositoryCorruptionError(
      "Operation",
      operation.id,
      "status, result, error, lease, or completion columns disagree",
    );
  }
  return {
    id: decodeOperationId(operation.id, "Operation", operation.id),
    accountId: decodeAccountId(operation.ownerUserId, "Operation", operation.id),
    interviewId: decodeInterviewId(operation.interviewId, "Operation", operation.id),
    idempotencyScope: operation.idempotencyScope,
    idempotencyKey: operation.idempotencyKey,
    type: operation.type,
    status: operation.status,
    expectedVersion: operation.expectedVersion,
    attemptCount: operation.attemptCount,
    lastAttemptAt: operation.lastAttemptAt,
    leaseAcquiredAt: operation.leaseAcquiredAt,
    leaseExpiresAt: operation.leaseExpiresAt,
    input: decodeJsonObject(operation.input, "Operation", operation.id, "input"),
    result,
    error,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    completedAt: operation.completedAt,
  };
}
