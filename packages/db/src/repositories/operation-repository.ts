import { randomBytes } from "node:crypto";
import type { AccountId, OperationId } from "@interview-agent/domain";
import type { SQL } from "drizzle-orm";
import { and, eq, gte, isNull, lt, lte, ne, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import { interviewSessions, operations, user } from "../schema/index.js";
import {
  RepositoryCorruptionError,
  RepositoryIdempotencyConflictError,
  RepositoryImmutableConflictError,
  RepositoryNotFoundError,
  RepositoryOperationLeaseConflictError,
  RepositoryOperationRetryConflictError,
  RepositoryUnsafePayloadError,
} from "./errors.js";
import { hashLeaseToken, payloadsEqual, validateOperationPayload } from "./operation-payload.js";
import { RepositoryExecution } from "./transaction.js";
import type {
  ClaimedOperation,
  ClaimOperation,
  CompleteOperationFailure,
  CompleteOperationSuccess,
  CreateOperation,
  CreateOrLoadOperationResult,
  OperationIdempotencyScope,
  RetryOperation,
  StoredOperation,
} from "./types.js";
import {
  decodeAccountId,
  decodeInterviewId,
  decodeJsonObject,
  decodeOperationId,
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
const MAX_LEASE_DURATION_MS = 24 * 60 * 60 * 1_000;
const databaseStatementTime = sql<Date>`statement_timestamp()`;

export class PgOperationRepository {
  private readonly execution: RepositoryExecution;

  constructor(
    database: Database,
    execution: RepositoryExecution = new RepositoryExecution(database),
  ) {
    this.execution = execution;
  }

  async create(operation: CreateOperation): Promise<StoredOperation> {
    return (await this.createOrLoad(operation)).operation;
  }

  async createOrLoad(operation: CreateOperation): Promise<CreateOrLoadOperationResult> {
    const scope = validateScope(operation.idempotencyScope, operation.id);
    const idempotencyKey = validateIdempotencyKey(operation.idempotencyKey, operation.id);
    const input = validateOperationPayload(operation.input, "input");
    const rows = await this.execution.executor
      .insert(operations)
      .values({
        id: operation.id,
        ownerUserId: operation.accountId,
        interviewId: operation.interviewId,
        idempotencyScope: scope,
        idempotencyKey,
        type: operation.type,
        status: "pending",
        expectedVersion: operation.expectedVersion,
        inputHash: input.hash,
        input: input.value,
        createdAt: operation.createdAt,
        updatedAt: operation.createdAt,
      })
      .onConflictDoNothing({
        target: [operations.ownerUserId, operations.idempotencyScope, operations.idempotencyKey],
      })
      .returning();
    const created = rows[0];
    if (created !== undefined) {
      return { operation: decodeOperation(created), created: true };
    }

    const existing = await this.findByIdempotencyKey(operation.accountId, scope, idempotencyKey);
    if (existing === null) {
      throw new RepositoryNotFoundError("Operation idempotency key", idempotencyKey);
    }
    if (
      existing.interviewId !== operation.interviewId ||
      existing.type !== operation.type ||
      existing.expectedVersion !== operation.expectedVersion ||
      !payloadsEqual(existing.input, input)
    ) {
      throw new RepositoryIdempotencyConflictError(scope, idempotencyKey);
    }
    return { operation: existing, created: false };
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
    scope: OperationIdempotencyScope,
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

  async claimPending(claim: ClaimOperation): Promise<ClaimedOperation | null> {
    const lease = createLease(claim);
    const rows = await this.execution.executor
      .update(operations)
      .set({
        status: "processing",
        attemptCount: sql`${operations.attemptCount} + 1`,
        lastAttemptAt: databaseStatementTime,
        leaseAcquiredAt: databaseStatementTime,
        leaseExpiresAt: lease.expiry,
        leaseOwner: lease.owner,
        leaseTokenHash: lease.tokenHash,
        updatedAt: databaseStatementTime,
      })
      .where(
        and(
          eq(operations.id, claim.operationId),
          eq(operations.ownerUserId, claim.accountId),
          eq(operations.status, "pending"),
        ),
      )
      .returning();
    return rows[0] === undefined ? null : claimedOperation(rows[0], lease);
  }

  async retryFailedAndClaim(retry: RetryOperation): Promise<ClaimedOperation> {
    const lease = createLease(retry);
    const input = validateOperationPayload(retry.input, "input");
    const rows = await this.execution.executor
      .update(operations)
      .set({
        status: "processing",
        attemptCount: sql`${operations.attemptCount} + 1`,
        lastAttemptAt: databaseStatementTime,
        leaseAcquiredAt: databaseStatementTime,
        leaseExpiresAt: lease.expiry,
        leaseOwner: lease.owner,
        leaseTokenHash: lease.tokenHash,
        completedLeaseOwner: null,
        completedLeaseTokenHash: null,
        retryable: false,
        error: null,
        completedAt: null,
        updatedAt: databaseStatementTime,
      })
      .where(
        and(
          eq(operations.id, retry.operationId),
          eq(operations.ownerUserId, retry.accountId),
          eq(operations.status, "failed"),
          eq(operations.retryable, true),
          eq(operations.input, input.value),
        ),
      )
      .returning();
    if (rows[0] !== undefined) {
      return claimedOperation(rows[0], lease);
    }
    return this.throwRetryConflict(retry.operationId, retry.accountId, input);
  }

  async reclaimStaleProcessing(retry: RetryOperation): Promise<ClaimedOperation> {
    const lease = createLease(retry);
    const input = validateOperationPayload(retry.input, "input");
    const rows = await this.execution.executor
      .update(operations)
      .set({
        attemptCount: sql`${operations.attemptCount} + 1`,
        lastAttemptAt: databaseStatementTime,
        leaseAcquiredAt: databaseStatementTime,
        leaseExpiresAt: lease.expiry,
        leaseOwner: lease.owner,
        leaseTokenHash: lease.tokenHash,
        updatedAt: databaseStatementTime,
      })
      .where(
        and(
          eq(operations.id, retry.operationId),
          eq(operations.ownerUserId, retry.accountId),
          eq(operations.status, "processing"),
          eq(operations.input, input.value),
          lt(operations.leaseExpiresAt, databaseStatementTime),
        ),
      )
      .returning();
    if (rows[0] !== undefined) {
      return claimedOperation(rows[0], lease);
    }
    return this.throwRetryConflict(retry.operationId, retry.accountId, input);
  }

  async completeSuccess(update: CompleteOperationSuccess): Promise<StoredOperation> {
    const lease = validateCompletionLease(update);
    const result = validateOperationPayload(update.result, "result");
    const rows = await this.execution.executor
      .update(operations)
      .set({
        status: "succeeded",
        result: result.value,
        error: null,
        leaseAcquiredAt: null,
        leaseExpiresAt: null,
        leaseOwner: null,
        leaseTokenHash: null,
        completedLeaseOwner: lease.owner,
        completedLeaseTokenHash: lease.tokenHash,
        retryable: false,
        completedAt: databaseStatementTime,
        updatedAt: databaseStatementTime,
      })
      .where(
        and(
          eq(operations.id, update.operationId),
          eq(operations.ownerUserId, update.accountId),
          eq(operations.status, "processing"),
          eq(operations.leaseOwner, lease.owner),
          eq(operations.leaseTokenHash, lease.tokenHash),
          eq(operations.attemptCount, lease.attemptCount),
          lte(operations.leaseAcquiredAt, databaseStatementTime),
          gte(operations.leaseExpiresAt, databaseStatementTime),
        ),
      )
      .returning();
    if (rows[0] !== undefined) {
      return decodeOperation(rows[0]);
    }
    return this.resolveDuplicateCompletion(update, "succeeded", result);
  }

  async completeFailure(update: CompleteOperationFailure): Promise<StoredOperation> {
    const lease = validateCompletionLease(update);
    const error = validateOperationPayload(update.error, "error");
    const rows = await this.execution.executor
      .update(operations)
      .set({
        status: "failed",
        result: null,
        error: error.value,
        leaseAcquiredAt: null,
        leaseExpiresAt: null,
        leaseOwner: null,
        leaseTokenHash: null,
        completedLeaseOwner: lease.owner,
        completedLeaseTokenHash: lease.tokenHash,
        retryable: update.retryable,
        completedAt: databaseStatementTime,
        updatedAt: databaseStatementTime,
      })
      .where(
        and(
          eq(operations.id, update.operationId),
          eq(operations.ownerUserId, update.accountId),
          eq(operations.status, "processing"),
          eq(operations.leaseOwner, lease.owner),
          eq(operations.leaseTokenHash, lease.tokenHash),
          eq(operations.attemptCount, lease.attemptCount),
          lte(operations.leaseAcquiredAt, databaseStatementTime),
          gte(operations.leaseExpiresAt, databaseStatementTime),
        ),
      )
      .returning();
    if (rows[0] !== undefined) {
      return decodeOperation(rows[0]);
    }
    return this.resolveDuplicateCompletion(update, "failed", error);
  }

  private async resolveDuplicateCompletion(
    update: CompleteOperationSuccess | CompleteOperationFailure,
    status: "succeeded" | "failed",
    payload: ReturnType<typeof validateOperationPayload>,
  ): Promise<StoredOperation> {
    const existing = await this.findById(update.operationId, update.accountId);
    if (existing === null) {
      throw new RepositoryNotFoundError("Operation", update.operationId);
    }
    const tokenHash = hashLeaseToken(update.leaseToken);
    const row = await this.findCompletionIdentity(update.operationId, update.accountId);
    const sameLease =
      row?.completedLeaseOwner === update.leaseOwner &&
      row.completedLeaseTokenHash === tokenHash &&
      existing.attemptCount === update.attemptCount;
    const samePayload =
      status === "succeeded"
        ? payloadsEqual(existing.result, payload)
        : payloadsEqual(existing.error, payload) &&
          existing.retryable === (update as CompleteOperationFailure).retryable;
    if (sameLease && existing.status === status && samePayload) {
      return existing;
    }
    throw new RepositoryOperationLeaseConflictError(update.operationId);
  }

  private async findCompletionIdentity(
    operationId: OperationId,
    accountId: AccountId,
  ): Promise<{
    readonly completedLeaseOwner: string | null;
    readonly completedLeaseTokenHash: string | null;
  } | null> {
    const rows = await this.execution.executor
      .select({
        completedLeaseOwner: operations.completedLeaseOwner,
        completedLeaseTokenHash: operations.completedLeaseTokenHash,
      })
      .from(operations)
      .where(and(eq(operations.id, operationId), eq(operations.ownerUserId, accountId)))
      .limit(1);
    return rows[0] ?? null;
  }

  private async throwRetryConflict(
    operationId: OperationId,
    accountId: AccountId,
    input: ReturnType<typeof validateOperationPayload>,
  ): Promise<never> {
    const existing = await this.findById(operationId, accountId);
    if (existing === null) {
      throw new RepositoryNotFoundError("Operation", operationId);
    }
    if (!payloadsEqual(existing.input, input)) {
      throw new RepositoryIdempotencyConflictError(
        existing.idempotencyScope,
        existing.idempotencyKey,
      );
    }
    throw new RepositoryOperationRetryConflictError(operationId);
  }
}

function validateScope(scope: string, operationId: OperationId): string {
  const normalized = scope.trim();
  if (normalized.length === 0 || normalized.length > 128) {
    throw new RepositoryImmutableConflictError("Operation idempotency scope", operationId);
  }
  return normalized;
}

function validateIdempotencyKey(key: string, operationId: OperationId): string {
  if (key.trim().length === 0 || key.length > 256) {
    throw new RepositoryImmutableConflictError("Operation idempotency key", operationId);
  }
  return key;
}

function createLease(claim: ClaimOperation): {
  readonly owner: string;
  readonly token: string;
  readonly tokenHash: string;
  readonly expiry: SQL<Date>;
} {
  if (
    !Number.isSafeInteger(claim.leaseDurationMs) ||
    claim.leaseDurationMs < 1 ||
    claim.leaseDurationMs > MAX_LEASE_DURATION_MS
  ) {
    throw new RepositoryOperationLeaseConflictError(claim.operationId);
  }
  const owner = claim.leaseOwner.trim();
  if (owner.length === 0 || owner.length > 256) {
    throw new RepositoryOperationLeaseConflictError(claim.operationId);
  }
  const token = randomBytes(32).toString("base64url");
  return {
    owner,
    token,
    tokenHash: hashLeaseToken(token),
    expiry: sql<Date>`statement_timestamp() + ${claim.leaseDurationMs} * interval '1 millisecond'`,
  };
}

function validateCompletionLease(update: CompleteOperationSuccess | CompleteOperationFailure): {
  readonly owner: string;
  readonly tokenHash: string;
  readonly attemptCount: number;
} {
  if (!Number.isSafeInteger(update.attemptCount) || update.attemptCount < 1) {
    throw new RepositoryOperationLeaseConflictError(update.operationId);
  }
  const owner = update.leaseOwner.trim();
  if (owner.length === 0 || owner.length > 256) {
    throw new RepositoryOperationLeaseConflictError(update.operationId);
  }
  return {
    owner,
    tokenHash: hashLeaseToken(update.leaseToken),
    attemptCount: update.attemptCount,
  };
}

function claimedOperation(
  row: typeof operations.$inferSelect,
  lease: { readonly owner: string; readonly token: string },
): ClaimedOperation {
  const operation = decodeOperation(row);
  return {
    operation,
    leaseOwner: lease.owner,
    leaseToken: lease.token,
    attemptCount: operation.attemptCount,
  };
}

function decodeOperation(
  row: { readonly operation: typeof operations.$inferSelect } | typeof operations.$inferSelect,
): StoredOperation {
  const operation = "operation" in row ? row.operation : row;
  if (
    operation.idempotencyScope.trim().length === 0 ||
    operation.idempotencyKey.trim().length === 0 ||
    operation.inputHash.length !== 64 ||
    operation.expectedVersion < 0 ||
    !Number.isInteger(operation.expectedVersion) ||
    operation.attemptCount < 0 ||
    !Number.isInteger(operation.attemptCount)
  ) {
    throw new RepositoryCorruptionError(
      "Operation",
      operation.id,
      "identity, fingerprint, or counters are invalid",
    );
  }
  const input = decodeSafePayload(operation.input, operation.id, "input");
  const inputFingerprint = validateOperationPayload(input, "input").hash;
  if (inputFingerprint !== operation.inputHash) {
    throw new RepositoryCorruptionError(
      "Operation",
      operation.id,
      "input fingerprint does not match persisted input",
    );
  }
  const result =
    operation.result === null ? null : decodeSafePayload(operation.result, operation.id, "result");
  const error =
    operation.error === null ? null : decodeSafePayload(operation.error, operation.id, "error");
  const hasActiveLease =
    operation.leaseAcquiredAt !== null &&
    operation.leaseExpiresAt !== null &&
    operation.leaseOwner !== null &&
    operation.leaseTokenHash !== null;
  const hasCompletionLease =
    operation.completedLeaseOwner !== null && operation.completedLeaseTokenHash !== null;
  if (
    (operation.status === "processing") !== hasActiveLease ||
    (operation.status === "succeeded" &&
      (result === null ||
        error !== null ||
        operation.completedAt === null ||
        !hasCompletionLease ||
        operation.retryable)) ||
    (operation.status === "failed" &&
      (error === null ||
        result !== null ||
        operation.completedAt === null ||
        !hasCompletionLease)) ||
    ((operation.status === "pending" || operation.status === "processing") &&
      (operation.completedAt !== null ||
        hasCompletionLease ||
        result !== null ||
        error !== null)) ||
    (operation.status !== "processing" &&
      (operation.leaseAcquiredAt !== null ||
        operation.leaseExpiresAt !== null ||
        operation.leaseOwner !== null ||
        operation.leaseTokenHash !== null))
  ) {
    throw new RepositoryCorruptionError(
      "Operation",
      operation.id,
      "status, result, error, lease, retry, or completion columns disagree",
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
    inputHash: operation.inputHash,
    attemptCount: operation.attemptCount,
    lastAttemptAt: operation.lastAttemptAt,
    leaseAcquiredAt: operation.leaseAcquiredAt,
    leaseExpiresAt: operation.leaseExpiresAt,
    leaseOwner: operation.leaseOwner,
    retryable: operation.retryable,
    input,
    result,
    error,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    completedAt: operation.completedAt,
  };
}

function decodeSafePayload(
  value: unknown,
  operationId: string,
  field: string,
): ReturnType<typeof decodeJsonObject> {
  const decoded = decodeJsonObject(value, "Operation", operationId, field);
  try {
    return validateOperationPayload(decoded, field).value;
  } catch (error) {
    if (error instanceof RepositoryUnsafePayloadError) {
      throw new RepositoryCorruptionError(
        "Operation",
        operationId,
        `${field} contains unsafe JSON`,
        { cause: error },
      );
    }
    throw error;
  }
}
