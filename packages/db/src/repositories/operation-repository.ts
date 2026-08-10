import { randomBytes } from "node:crypto";
import type { AccountId, OperationId } from "@interview-agent/domain";
import type { SQL } from "drizzle-orm";
import { and, eq, gte, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import { deletionRequests, interviewSessions, operations, user } from "../schema/index.js";
import {
  RepositoryCorruptionError,
  RepositoryIdempotencyConflictError,
  RepositoryImmutableConflictError,
  RepositoryInterviewUnavailableError,
  RepositoryNotFoundError,
  RepositoryOperationLeaseConflictError,
  RepositoryOperationRetryConflictError,
  RepositoryUnsafePayloadError,
} from "./errors.js";
import { expireInterviewOrSignal, runRepositoryTransaction } from "./interview-expiry-handling.js";
import { hashLeaseToken, payloadsEqual, validateOperationPayload } from "./operation-payload.js";
import { type DatabaseExecutor, RepositoryExecution } from "./transaction.js";
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
    const result = await runRepositoryTransaction(this.execution, async (executor) => {
      const ownerRows = await executor
        .select({ deletionRequestedAt: user.deletionRequestedAt })
        .from(user)
        .where(eq(user.id, operation.accountId))
        .limit(1)
        .for("update");
      const owner = ownerRows[0];
      if (owner === undefined) {
        throw new RepositoryNotFoundError("account", operation.accountId);
      }

      const existing = await findRawByIdempotencyKey(
        executor,
        operation.accountId,
        scope,
        idempotencyKey,
      );
      const interviewIds = [...new Set([operation.interviewId, existing?.interviewId])].filter(
        (value): value is import("@interview-agent/domain").InterviewId => value !== undefined,
      );
      interviewIds.sort();
      const lockedInterviews: {
        readonly id: string;
        readonly status: typeof interviewSessions.$inferSelect.status;
        readonly version: number;
        readonly deletionRequestedAt: Date | null;
      }[] = [];
      for (const interviewId of interviewIds) {
        const rows = await executor
          .select({
            id: interviewSessions.id,
            status: interviewSessions.status,
            version: interviewSessions.version,
            deletionRequestedAt: interviewSessions.deletionRequestedAt,
          })
          .from(interviewSessions)
          .where(
            and(
              eq(interviewSessions.id, interviewId),
              eq(interviewSessions.ownerUserId, operation.accountId),
            ),
          )
          .limit(1)
          .for("update");
        const row = rows[0];
        if (row === undefined) {
          throw new RepositoryNotFoundError("interview", interviewId);
        }
        lockedInterviews.push(row);
      }

      const deletionRows = await executor
        .select({
          interviewId: deletionRequests.interviewId,
          scope: deletionRequests.scope,
        })
        .from(deletionRequests)
        .where(
          or(
            and(
              eq(deletionRequests.scope, "account"),
              eq(deletionRequests.ownerUserId, operation.accountId),
            ),
            inArray(deletionRequests.interviewId, interviewIds),
          ),
        )
        .limit(1);
      const deletionMarked =
        owner.deletionRequestedAt !== null ||
        lockedInterviews.some(
          (interview) => interview.status === "deleting" || interview.deletionRequestedAt !== null,
        ) ||
        deletionRows.length !== 0;
      if (deletionMarked) {
        const target =
          lockedInterviews.find((interview) => interview.id === operation.interviewId) ??
          lockedInterviews[0];
        throw new RepositoryInterviewUnavailableError(
          operation.interviewId,
          "deleting",
          target?.version ?? 0,
        );
      }

      if (existing !== null) {
        this.assertDuplicateMatches(existing, operation, input);
      }

      const expiry = await expireInterviewOrSignal(executor, {
        interviewId: operation.interviewId,
        accountId: operation.accountId,
      });
      if (existing !== null) {
        const refreshed = await findRawByIdempotencyKey(
          executor,
          operation.accountId,
          scope,
          idempotencyKey,
        );
        if (refreshed === null) {
          return new RepositoryNotFoundError("Operation", existing.id);
        }
        return { operation: refreshed, created: false };
      }
      if (
        expiry.kind === "not_found" ||
        (expiry.kind === "unchanged" &&
          expiry.status !== "active" &&
          expiry.status !== "report_pending")
      ) {
        if (expiry.kind === "not_found") {
          throw new RepositoryNotFoundError("interview", operation.interviewId);
        }
        return new RepositoryInterviewUnavailableError(
          operation.interviewId,
          expiry.status,
          expiry.version,
        );
      }

      const rows = await executor
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
        .returning();
      return {
        operation: decodeOperation(requiredOperation(rows, operation.id)),
        created: true,
      };
    });
    if (result instanceof Error) {
      throw result;
    }
    return result;
  }

  private assertDuplicateMatches(
    existing: StoredOperation,
    operation: CreateOperation,
    input: ReturnType<typeof validateOperationPayload>,
  ): void {
    if (
      existing.interviewId !== operation.interviewId ||
      existing.type !== operation.type ||
      existing.expectedVersion !== operation.expectedVersion ||
      !payloadsEqual(existing.input, input)
    ) {
      throw new RepositoryIdempotencyConflictError(
        existing.idempotencyScope,
        existing.idempotencyKey,
      );
    }
  }

  async findById(operationId: OperationId, accountId: AccountId): Promise<StoredOperation | null> {
    return runRepositoryTransaction(this.execution, async (executor) => {
      await this.expireOperationInterview(executor, operationId, accountId);
      return this.findAccessibleById(executor, operationId, accountId);
    });
  }

  private async findAccessibleById(
    executor: DatabaseExecutor,
    operationId: OperationId,
    accountId: AccountId,
  ): Promise<StoredOperation | null> {
    const rows = await executor
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
    return runRepositoryTransaction(this.execution, async (executor) => {
      const operationRows = await executor
        .select({ interviewId: operations.interviewId })
        .from(operations)
        .where(
          and(
            eq(operations.ownerUserId, accountId),
            eq(operations.idempotencyScope, scope),
            eq(operations.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      const interviewId = operationRows[0]?.interviewId;
      if (interviewId !== undefined) {
        await expireInterviewOrSignal(executor, {
          interviewId: decodeInterviewId(interviewId, "Operation", idempotencyKey),
          accountId,
        });
      }
      const rows = await executor
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
    });
  }

  async claimPending(claim: ClaimOperation): Promise<ClaimedOperation | null> {
    const lease = createLease(claim);
    const result = await runRepositoryTransaction(this.execution, async (executor) => {
      const unavailable = await this.assertOperationInterviewMutable(
        executor,
        claim.operationId,
        claim.accountId,
      );
      if (unavailable !== null) {
        return unavailable;
      }
      const rows = await executor
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
    });
    if (result instanceof Error) {
      throw result;
    }
    return result;
  }

  async retryFailedAndClaim(retry: RetryOperation): Promise<ClaimedOperation> {
    const lease = createLease(retry);
    const input = validateOperationPayload(retry.input, "input");
    const result = await runRepositoryTransaction(this.execution, async (executor) => {
      const unavailable = await this.lockOperationInterviewForRetry(
        executor,
        retry.operationId,
        retry.accountId,
      );
      if (unavailable !== null) {
        return unavailable;
      }
      const rows = await executor
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
      return throwRetryConflict(executor, retry.operationId, retry.accountId, input);
    });
    if (result instanceof Error) {
      throw result;
    }
    return result;
  }

  async reclaimStaleProcessing(retry: RetryOperation): Promise<ClaimedOperation> {
    const lease = createLease(retry);
    const input = validateOperationPayload(retry.input, "input");
    const result = await runRepositoryTransaction(this.execution, async (executor) => {
      const unavailable = await this.assertOperationInterviewMutable(
        executor,
        retry.operationId,
        retry.accountId,
      );
      if (unavailable !== null) {
        return unavailable;
      }
      const rows = await executor
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
      return throwRetryConflict(executor, retry.operationId, retry.accountId, input);
    });
    if (result instanceof Error) {
      throw result;
    }
    return result;
  }

  async completeSuccess(update: CompleteOperationSuccess): Promise<StoredOperation> {
    const lease = validateCompletionLease(update);
    const result = validateOperationPayload(update.result, "result");
    const completion = await runRepositoryTransaction(this.execution, async (executor) => {
      await this.expireOperationInterview(executor, update.operationId, update.accountId);
      const rows = await executor
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
      return this.resolveDuplicateCompletion(executor, update, "succeeded", result);
    });
    if (completion instanceof Error) {
      throw completion;
    }
    return completion;
  }

  async completeFailure(update: CompleteOperationFailure): Promise<StoredOperation> {
    const lease = validateCompletionLease(update);
    const error = validateOperationPayload(update.error, "error");
    const completion = await runRepositoryTransaction(this.execution, async (executor) => {
      await this.expireOperationInterview(executor, update.operationId, update.accountId);
      const rows = await executor
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
      return this.resolveDuplicateCompletion(executor, update, "failed", error);
    });
    if (completion instanceof Error) {
      throw completion;
    }
    return completion;
  }

  private async resolveDuplicateCompletion(
    executor: DatabaseExecutor,
    update: CompleteOperationSuccess | CompleteOperationFailure,
    status: "succeeded" | "failed",
    payload: ReturnType<typeof validateOperationPayload>,
  ): Promise<StoredOperation> {
    const existing = await this.findAccessibleById(executor, update.operationId, update.accountId);
    if (existing === null) {
      throw new RepositoryNotFoundError("Operation", update.operationId);
    }
    const tokenHash = hashLeaseToken(update.leaseToken);
    const row = await this.findCompletionIdentity(executor, update.operationId, update.accountId);
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
    executor: DatabaseExecutor,
    operationId: OperationId,
    accountId: AccountId,
  ): Promise<{
    readonly completedLeaseOwner: string | null;
    readonly completedLeaseTokenHash: string | null;
  } | null> {
    const rows = await executor
      .select({
        completedLeaseOwner: operations.completedLeaseOwner,
        completedLeaseTokenHash: operations.completedLeaseTokenHash,
      })
      .from(operations)
      .where(and(eq(operations.id, operationId), eq(operations.ownerUserId, accountId)))
      .limit(1);
    return rows[0] ?? null;
  }

  private async assertInterviewMutable(
    executor: DatabaseExecutor,
    interviewId: import("@interview-agent/domain").InterviewId,
    accountId: AccountId,
  ): Promise<RepositoryInterviewUnavailableError | null> {
    const expiry = await expireInterviewOrSignal(executor, {
      interviewId,
      accountId,
    });
    if (
      expiry.kind === "unchanged" &&
      expiry.status !== "active" &&
      expiry.status !== "report_pending"
    ) {
      return new RepositoryInterviewUnavailableError(interviewId, expiry.status, expiry.version);
    }
    const rows = await executor
      .select({
        status: interviewSessions.status,
        version: interviewSessions.version,
        interviewDeletionRequestedAt: interviewSessions.deletionRequestedAt,
        accountDeletionRequestedAt: user.deletionRequestedAt,
      })
      .from(interviewSessions)
      .innerJoin(user, eq(user.id, interviewSessions.ownerUserId))
      .where(
        and(eq(interviewSessions.id, interviewId), eq(interviewSessions.ownerUserId, accountId)),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new RepositoryNotFoundError("interview", interviewId);
    }
    const requestRows = await executor
      .select({ id: deletionRequests.id })
      .from(deletionRequests)
      .where(
        or(
          eq(deletionRequests.interviewId, interviewId),
          and(eq(deletionRequests.scope, "account"), eq(deletionRequests.ownerUserId, accountId)),
        ),
      )
      .limit(1);
    if (
      row.status === "deleting" ||
      row.interviewDeletionRequestedAt !== null ||
      row.accountDeletionRequestedAt !== null ||
      requestRows.length !== 0
    ) {
      return new RepositoryInterviewUnavailableError(interviewId, "deleting", row.version);
    }
    return null;
  }

  private async assertOperationInterviewMutable(
    executor: DatabaseExecutor,
    operationId: OperationId,
    accountId: AccountId,
  ): Promise<RepositoryInterviewUnavailableError | null> {
    const interview = await this.findOperationInterview(executor, operationId, accountId);
    if (interview === null) {
      return null;
    }
    return this.assertInterviewMutable(executor, interview, accountId);
  }

  private async lockOperationInterviewForRetry(
    executor: DatabaseExecutor,
    operationId: OperationId,
    accountId: AccountId,
  ): Promise<RepositoryInterviewUnavailableError | null> {
    const operationRows = await executor
      .select({ interviewId: operations.interviewId })
      .from(operations)
      .where(and(eq(operations.id, operationId), eq(operations.ownerUserId, accountId)))
      .limit(1);
    const rawInterviewId = operationRows[0]?.interviewId;
    if (rawInterviewId === undefined) {
      return null;
    }
    const interviewId = decodeInterviewId(rawInterviewId, "Operation", operationId);

    const ownerRows = await executor
      .select({ deletionRequestedAt: user.deletionRequestedAt })
      .from(user)
      .where(eq(user.id, accountId))
      .limit(1)
      .for("update");
    const owner = ownerRows[0];
    if (owner === undefined) {
      return null;
    }

    const interviewRows = await executor
      .select({
        status: interviewSessions.status,
        version: interviewSessions.version,
        deletionRequestedAt: interviewSessions.deletionRequestedAt,
      })
      .from(interviewSessions)
      .where(
        and(eq(interviewSessions.id, interviewId), eq(interviewSessions.ownerUserId, accountId)),
      )
      .limit(1)
      .for("update");
    const interview = interviewRows[0];
    if (interview === undefined) {
      return null;
    }

    const expiry = await expireInterviewOrSignal(executor, { interviewId, accountId });
    if (
      expiry.kind === "unchanged" &&
      expiry.status !== "active" &&
      expiry.status !== "report_pending"
    ) {
      return new RepositoryInterviewUnavailableError(interviewId, expiry.status, expiry.version);
    }

    const deletionRows = await executor
      .select({ id: deletionRequests.id })
      .from(deletionRequests)
      .where(
        or(
          eq(deletionRequests.interviewId, interviewId),
          and(eq(deletionRequests.scope, "account"), eq(deletionRequests.ownerUserId, accountId)),
        ),
      )
      .limit(1);
    if (
      owner.deletionRequestedAt !== null ||
      interview.status === "deleting" ||
      interview.deletionRequestedAt !== null ||
      deletionRows.length !== 0
    ) {
      return new RepositoryInterviewUnavailableError(interviewId, "deleting", interview.version);
    }
    return null;
  }

  private async expireOperationInterview(
    executor: DatabaseExecutor,
    operationId: OperationId,
    accountId: AccountId,
  ): Promise<void> {
    const interviewId = await this.findOperationInterview(executor, operationId, accountId);
    if (interviewId !== null) {
      await expireInterviewOrSignal(executor, { interviewId, accountId });
    }
  }

  private async findOperationInterview(
    executor: DatabaseExecutor,
    operationId: OperationId,
    accountId: AccountId,
  ): Promise<import("@interview-agent/domain").InterviewId | null> {
    const rows = await executor
      .select({ interviewId: operations.interviewId })
      .from(operations)
      .where(and(eq(operations.id, operationId), eq(operations.ownerUserId, accountId)))
      .limit(1);
    const interviewId = rows[0]?.interviewId;
    return interviewId === undefined
      ? null
      : decodeInterviewId(interviewId, "Operation", operationId);
  }
}

async function throwRetryConflict(
  executor: DatabaseExecutor,
  operationId: OperationId,
  accountId: AccountId,
  input: ReturnType<typeof validateOperationPayload>,
): Promise<never> {
  const rows = await executor
    .select()
    .from(operations)
    .where(and(eq(operations.id, operationId), eq(operations.ownerUserId, accountId)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new RepositoryNotFoundError("Operation", operationId);
  }
  const existing = decodeOperation(row);
  if (!payloadsEqual(existing.input, input)) {
    throw new RepositoryIdempotencyConflictError(
      existing.idempotencyScope,
      existing.idempotencyKey,
    );
  }
  throw new RepositoryOperationRetryConflictError(operationId);
}

async function findRawByIdempotencyKey(
  executor: DatabaseExecutor,
  accountId: AccountId,
  scope: OperationIdempotencyScope,
  idempotencyKey: string,
): Promise<StoredOperation | null> {
  const rows = await executor
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.ownerUserId, accountId),
        eq(operations.idempotencyScope, scope),
        eq(operations.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return rows[0] === undefined ? null : decodeOperation(rows[0]);
}

function requiredOperation(
  rows: readonly (typeof operations.$inferSelect)[],
  operationId: OperationId,
): typeof operations.$inferSelect {
  const row = rows[0];
  if (row === undefined) {
    throw new RepositoryNotFoundError("Operation", operationId);
  }
  return row;
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
