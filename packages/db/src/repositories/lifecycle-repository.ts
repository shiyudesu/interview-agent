import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AccountId, InterviewId } from "@interview-agent/domain";
import { and, asc, eq, inArray, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import {
  deletionRequests,
  interviewSessions,
  operations,
  purgeAuditEvents,
  session,
  user,
  verification,
} from "../schema/index.js";
import { type DatabaseExecutor, RepositoryExecution } from "./transaction.js";

const databaseStatementTime = sql<Date>`statement_timestamp()`;
const systemCompletionTokenHash = sql<string>`
  encode(sha256(convert_to('interview-lifecycle:' || ${operations.id}, 'UTF8')), 'hex')
`;
const MINIMUM_PURGE_LEASE_DURATION_MS = 30_000;
const PURGE_DEADLINE_SAFETY_WINDOW_MS = 30_000;
const PURGE_DEADLINE_FENCING_LEASE_DURATION_MS = 3_000;

export type InterviewExpiryResult =
  | {
      readonly kind: "not_found";
      readonly interviewId: InterviewId;
    }
  | {
      readonly kind: "unchanged";
      readonly interviewId: InterviewId;
      readonly status: typeof interviewSessions.$inferSelect.status;
      readonly version: number;
      readonly endedAt: Date | null;
      readonly expectedVersionMatches: boolean | null;
    }
  | {
      readonly kind: "expired";
      readonly interviewId: InterviewId;
      readonly previousVersion: number;
      readonly version: number;
      readonly expiredAt: Date;
      readonly cancelledOperationCount: number;
      readonly expectedVersionMatches: boolean | null;
    };

export interface MarkDeletionResult {
  readonly requestId: string;
  readonly scope: "account" | "interview";
  readonly ownerUserId: string;
  readonly interviewId: string | null;
  readonly requestedAt: Date;
  readonly purgeDueAt: Date;
  readonly purgeDeadlineAt: Date;
  readonly created: boolean;
  readonly affectedInterviewCount: number;
  readonly cancelledOperationCount: number;
}

export interface ClaimedDeletionRequest {
  readonly requestId: string;
  readonly ownerUserId: string;
  readonly scope: "account" | "interview";
  readonly interviewId: string | null;
  readonly requestedAt: Date;
  readonly purgeDueAt: Date;
  readonly purgeDeadlineAt: Date;
  readonly attemptCount: number;
  readonly leaseOwner: string;
  readonly leaseToken: string;
}

export interface PurgeFailure {
  readonly category: "database" | "constraint" | "unknown";
  readonly code: string;
}

export interface DeletionOverdueProjection {
  readonly overdueCount: number;
  readonly oldestPurgeDeadlineAt: Date | null;
  readonly maximumOverdueSeconds: number;
}

export interface LifecycleRepositoryOptions {
  readonly deletionRequestId?: () => string;
}

export class PgLifecycleRepository {
  private readonly execution: RepositoryExecution;
  private readonly deletionRequestId: () => string;

  constructor(
    database: Database,
    execution: RepositoryExecution = new RepositoryExecution(database),
    options: LifecycleRepositoryOptions = {},
  ) {
    this.execution = execution;
    this.deletionRequestId = options.deletionRequestId ?? randomUUID;
  }

  expireInterviewIfNeeded(input: {
    readonly interviewId: InterviewId;
    readonly accountId?: AccountId;
    readonly expectedVersion?: number;
  }): Promise<InterviewExpiryResult> {
    return this.execution.inTransaction((executor) => expireInterviewIfNeeded(executor, input));
  }

  async sweepExpiredBatch(batchSize: number): Promise<readonly InterviewExpiryResult[]> {
    const validatedBatchSize = validateBatchSize(batchSize);
    return this.execution.inTransaction(async (executor) => {
      const candidates = await executor
        .select({
          id: interviewSessions.id,
          ownerUserId: interviewSessions.ownerUserId,
        })
        .from(interviewSessions)
        .innerJoin(user, eq(user.id, interviewSessions.ownerUserId))
        .where(
          and(
            eq(interviewSessions.status, "active"),
            isNull(interviewSessions.deletionRequestedAt),
            isNull(user.deletionRequestedAt),
            sql`${databaseStatementTime} - ${interviewSessions.lastEffectiveActivityAt} > interval '24 hours'`,
          ),
        )
        .orderBy(asc(interviewSessions.lastEffectiveActivityAt), asc(interviewSessions.id))
        .limit(validatedBatchSize)
        .for("update", { skipLocked: true });

      const results: InterviewExpiryResult[] = [];
      for (const candidate of candidates) {
        results.push(
          await expireInterviewIfNeeded(executor, {
            interviewId: candidate.id as InterviewId,
            accountId: candidate.ownerUserId as AccountId,
          }),
        );
      }
      return results;
    });
  }

  markInterviewDeleting(
    interviewId: InterviewId,
    accountId: AccountId,
  ): Promise<MarkDeletionResult | null> {
    return this.execution.inTransaction(async (executor) => {
      const accountRows = await executor
        .select({ deletionRequestedAt: user.deletionRequestedAt })
        .from(user)
        .where(eq(user.id, accountId))
        .limit(1)
        .for("update");
      const owner = accountRows[0];
      if (owner === undefined || owner.deletionRequestedAt !== null) {
        return null;
      }

      const rows = await executor
        .select({
          interview: interviewSessions,
        })
        .from(interviewSessions)
        .where(
          and(eq(interviewSessions.id, interviewId), eq(interviewSessions.ownerUserId, accountId)),
        )
        .limit(1)
        .for("update");
      const row = rows[0];
      if (row === undefined) {
        return null;
      }

      const existing = await findInterviewDeletionRequest(executor, interviewId, accountId);
      if (existing !== null) {
        return deletionResult(existing, false, 0, 0);
      }

      const updated = await executor
        .update(interviewSessions)
        .set({
          status: "deleting",
          activePhase: null,
          version: sql`${interviewSessions.version} + 1`,
          pendingOperationId: null,
          pendingOperationKind: null,
          pendingOperationQuestionPosition: null,
          pendingOperationAcceptedAt: null,
          pendingOperationPreviousPhase: null,
          pendingReportKind: null,
          reportRequestedAt: null,
          deletionRequestedAt: databaseStatementTime,
        })
        .where(
          and(eq(interviewSessions.id, interviewId), eq(interviewSessions.ownerUserId, accountId)),
        )
        .returning({ id: interviewSessions.id });
      const cancelledOperationCount = await cancelOpenOperations(executor, {
        interviewId,
        errorCode: "interview_deletion_requested",
      });
      const inserted = await executor
        .insert(deletionRequests)
        .values({
          id: this.deletionRequestId(),
          ownerUserId: accountId,
          scope: "interview",
          interviewId,
          requestedAt: databaseStatementTime,
          inaccessibleAt: databaseStatementTime,
          purgeDueAt: sql`${databaseStatementTime} + interval '6 days'`,
          purgeDeadlineAt: sql`${databaseStatementTime} + interval '7 days'`,
        })
        .returning();
      const request = requiredRow(inserted, "interview deletion request");
      return deletionResult(request, true, updated.length, cancelledOperationCount);
    });
  }

  markAccountDeleting(accountId: AccountId): Promise<MarkDeletionResult | null> {
    return this.execution.inTransaction(async (executor) => {
      // Session refreshes lock their session row before the trigger locks the user row.
      await executor
        .select({ id: session.id })
        .from(session)
        .where(eq(session.userId, accountId))
        .orderBy(asc(session.id))
        .for("update");

      const accountRows = await executor
        .select()
        .from(user)
        .where(eq(user.id, accountId))
        .limit(1)
        .for("update");
      if (accountRows[0] === undefined) {
        return null;
      }

      const existingRows = await executor
        .select()
        .from(deletionRequests)
        .where(
          and(eq(deletionRequests.ownerUserId, accountId), eq(deletionRequests.scope, "account")),
        )
        .limit(1);
      const existing = existingRows[0];

      await executor
        .update(user)
        .set({
          deletionRequestedAt: sql`coalesce(${user.deletionRequestedAt}, ${databaseStatementTime})`,
        })
        .where(eq(user.id, accountId));
      await executor.delete(session).where(eq(session.userId, accountId));
      const affectedInterviews = await executor
        .update(interviewSessions)
        .set({
          status: "deleting",
          activePhase: null,
          version: sql`${interviewSessions.version} + 1`,
          pendingOperationId: null,
          pendingOperationKind: null,
          pendingOperationQuestionPosition: null,
          pendingOperationAcceptedAt: null,
          pendingOperationPreviousPhase: null,
          pendingReportKind: null,
          reportRequestedAt: null,
          deletionRequestedAt: sql`coalesce(${interviewSessions.deletionRequestedAt}, ${databaseStatementTime})`,
        })
        .where(
          and(
            eq(interviewSessions.ownerUserId, accountId),
            sql`${interviewSessions.status} is distinct from 'deleting'`,
          ),
        )
        .returning({ id: interviewSessions.id });
      const cancelledOperationCount = await cancelOpenOperations(executor, {
        accountId,
        errorCode: "account_deletion_requested",
      });

      if (existing !== undefined) {
        return deletionResult(existing, false, affectedInterviews.length, cancelledOperationCount);
      }
      const inserted = await executor
        .insert(deletionRequests)
        .values({
          id: this.deletionRequestId(),
          ownerUserId: accountId,
          scope: "account",
          requestedAt: databaseStatementTime,
          inaccessibleAt: databaseStatementTime,
          purgeDueAt: sql`${databaseStatementTime} + interval '6 days'`,
          purgeDeadlineAt: sql`${databaseStatementTime} + interval '7 days'`,
        })
        .returning();
      return deletionResult(
        requiredRow(inserted, "account deletion request"),
        true,
        affectedInterviews.length,
        cancelledOperationCount,
      );
    });
  }

  claimDueDeletionRequests(input: {
    readonly batchSize: number;
    readonly leaseOwner: string;
    readonly leaseDurationMs: number;
    readonly failedRetryDelayMs: number;
    readonly excludedRequestIds?: readonly string[];
  }): Promise<readonly ClaimedDeletionRequest[]> {
    const batchSize = validateBatchSize(input.batchSize);
    const leaseOwner = validateLeaseOwner(input.leaseOwner);
    const leaseDurationMs = validatePurgeLeaseDuration(input.leaseDurationMs);
    const failedRetryDelayMs = validateRetryDelay(input.failedRetryDelayMs, "failed retry delay");
    const excludedRequestIds = [...new Set(input.excludedRequestIds ?? [])];
    return this.execution.inTransaction(async (executor) => {
      const candidates = await executor
        .select()
        .from(deletionRequests)
        .where(
          and(
            lte(deletionRequests.purgeDueAt, databaseStatementTime),
            or(
              eq(deletionRequests.status, "pending"),
              and(
                eq(deletionRequests.status, "failed"),
                lte(
                  sql<Date>`
                    least(
                      coalesce(
                        ${deletionRequests.lastAttemptAt}
                          + (${failedRetryDelayMs} * interval '1 millisecond'),
                        ${databaseStatementTime}
                      ),
                      ${deletionRequests.purgeDeadlineAt} - interval '1 minute'
                    )
                  `,
                  databaseStatementTime,
                ),
              ),
              and(
                eq(deletionRequests.status, "processing"),
                lte(deletionRequests.leaseExpiresAt, databaseStatementTime),
              ),
            ),
            excludedRequestIds.length === 0
              ? sql`true`
              : notInArray(deletionRequests.id, excludedRequestIds),
          ),
        )
        .orderBy(
          sql`(${deletionRequests.purgeDeadlineAt} <= ${databaseStatementTime}) desc`,
          sql`coalesce(${deletionRequests.lastAttemptAt}, ${deletionRequests.purgeDueAt}) asc`,
          asc(deletionRequests.purgeDeadlineAt),
          asc(deletionRequests.purgeDueAt),
          asc(deletionRequests.id),
        )
        .limit(batchSize)
        .for("update", { skipLocked: true });

      const claimed: ClaimedDeletionRequest[] = [];
      for (const candidate of candidates) {
        const leaseToken = randomBytes(32).toString("base64url");
        const leaseTokenHash = hashToken(leaseToken);
        const rows = await executor
          .update(deletionRequests)
          .set({
            status: "processing",
            attemptCount: sql`${deletionRequests.attemptCount} + 1`,
            lastAttemptAt: databaseStatementTime,
            processingStartedAt: databaseStatementTime,
            leaseExpiresAt: sql`
              case
                when ${deletionRequests.purgeDeadlineAt}
                  - (${PURGE_DEADLINE_SAFETY_WINDOW_MS} * interval '1 millisecond')
                  > ${databaseStatementTime}
                then least(
                  ${databaseStatementTime} + (${leaseDurationMs} * interval '1 millisecond'),
                  ${deletionRequests.purgeDeadlineAt}
                    - (${PURGE_DEADLINE_SAFETY_WINDOW_MS} * interval '1 millisecond')
                )
                else ${databaseStatementTime}
                  + (${PURGE_DEADLINE_FENCING_LEASE_DURATION_MS} * interval '1 millisecond')
              end
            `,
            leaseOwner,
            leaseTokenHash,
            completedAt: null,
            lastErrorCategory: null,
            lastErrorCode: null,
          })
          .where(eq(deletionRequests.id, candidate.id))
          .returning();
        const request = requiredRow(rows, "claimed deletion request");
        claimed.push({
          requestId: request.id,
          ownerUserId: request.ownerUserId,
          scope: request.scope,
          interviewId: request.interviewId,
          requestedAt: request.requestedAt,
          purgeDueAt: request.purgeDueAt,
          purgeDeadlineAt: request.purgeDeadlineAt,
          attemptCount: request.attemptCount,
          leaseOwner,
          leaseToken,
        });
      }
      return claimed;
    });
  }

  purgeClaimedDeletionRequest(
    claim: ClaimedDeletionRequest,
    subjectIdentifierHash: string,
  ): Promise<boolean> {
    validateSubjectHash(subjectIdentifierHash);
    return this.execution.inTransaction(async (executor) => {
      const leaseTokenHash = hashToken(claim.leaseToken);
      const rows = await executor
        .select()
        .from(deletionRequests)
        .where(
          and(
            eq(deletionRequests.id, claim.requestId),
            eq(deletionRequests.status, "processing"),
            eq(deletionRequests.attemptCount, claim.attemptCount),
            eq(deletionRequests.leaseOwner, claim.leaseOwner),
            eq(deletionRequests.leaseTokenHash, leaseTokenHash),
            sql`${deletionRequests.leaseExpiresAt} > ${databaseStatementTime}`,
            lte(deletionRequests.purgeDueAt, databaseStatementTime),
          ),
        )
        .limit(1)
        .for("update");
      const request = rows[0];
      if (request === undefined) {
        return false;
      }

      const purgedAt = databaseStatementTime;
      const categories =
        request.scope === "account"
          ? ([
              "account",
              "authentication",
              "interview",
              "message",
              "evaluation",
              "operation",
              "report",
            ] as const)
          : (["interview", "message", "evaluation", "operation", "report"] as const);

      if (request.scope === "account") {
        const ownerRows = await executor
          .select({ email: user.email })
          .from(user)
          .where(eq(user.id, request.ownerUserId))
          .limit(1)
          .for("update");
        const owner = ownerRows[0];
        if (owner === undefined) {
          return false;
        }
        const ownedVerification = verificationOwnedByAccount(request.ownerUserId, owner.email);
        await executor
          .delete(deletionRequests)
          .where(eq(deletionRequests.ownerUserId, request.ownerUserId));
        await executor
          .delete(interviewSessions)
          .where(eq(interviewSessions.ownerUserId, request.ownerUserId));
        await executor.delete(verification).where(ownedVerification);
        const remainingVerificationRows = await executor
          .select({ id: verification.id })
          .from(verification)
          .where(ownedVerification)
          .limit(1);
        if (remainingVerificationRows.length !== 0) {
          throw new Error("Account verification identifiers remain after purge");
        }
        await executor.delete(user).where(eq(user.id, request.ownerUserId));
      } else {
        if (request.interviewId === null) {
          return false;
        }
        await executor.delete(deletionRequests).where(eq(deletionRequests.id, request.id));
        const deleted = await executor
          .delete(interviewSessions)
          .where(
            and(
              eq(interviewSessions.id, request.interviewId),
              eq(interviewSessions.ownerUserId, request.ownerUserId),
            ),
          )
          .returning({ id: interviewSessions.id });
        if (deleted.length !== 1) {
          throw new Error("Deletion request target interview is missing");
        }
      }

      await executor.insert(purgeAuditEvents).values(
        categories.map((dataCategory) => ({
          subjectIdentifierHash,
          dataCategory,
          result: "succeeded" as const,
          purgedAt,
        })),
      );
      return true;
    });
  }

  recordPurgeFailure(
    claim: ClaimedDeletionRequest,
    failure: PurgeFailure,
    retryDelayMs: number,
  ): Promise<boolean> {
    const category = validateErrorPart(failure.category, 32, "failure category");
    const code = validateErrorPart(failure.code, 64, "failure code");
    validateRetryDelay(retryDelayMs, "failed retry delay");
    return this.execution.inTransaction(async (executor) => {
      const rows = await executor
        .update(deletionRequests)
        .set({
          status: "failed",
          lastAttemptAt: databaseStatementTime,
          processingStartedAt: null,
          leaseExpiresAt: null,
          leaseOwner: null,
          leaseTokenHash: null,
          lastErrorCategory: category,
          lastErrorCode: code,
        })
        .where(
          and(
            eq(deletionRequests.id, claim.requestId),
            eq(deletionRequests.status, "processing"),
            eq(deletionRequests.attemptCount, claim.attemptCount),
            eq(deletionRequests.leaseOwner, claim.leaseOwner),
            eq(deletionRequests.leaseTokenHash, hashToken(claim.leaseToken)),
          ),
        )
        .returning({ id: deletionRequests.id });
      return rows.length === 1;
    });
  }

  getDeletionOverdueProjection(): Promise<DeletionOverdueProjection> {
    return this.execution.inTransaction(async (executor) => {
      const rows = await executor
        .select({
          overdueCount: sql<number>`count(*)::integer`,
          oldestPurgeDeadlineAt: sql<Date | null>`min(${deletionRequests.purgeDeadlineAt})`,
          maximumOverdueSeconds: sql<number>`
            coalesce(extract(epoch from (${databaseStatementTime} - min(${deletionRequests.purgeDeadlineAt}))), 0)::double precision
          `,
        })
        .from(deletionRequests)
        .where(
          and(
            inArray(deletionRequests.status, ["pending", "processing", "failed"]),
            lt(deletionRequests.purgeDeadlineAt, databaseStatementTime),
          ),
        );
      const row = rows[0];
      if (row === undefined) {
        return { overdueCount: 0, oldestPurgeDeadlineAt: null, maximumOverdueSeconds: 0 };
      }
      return {
        overdueCount: row.overdueCount,
        oldestPurgeDeadlineAt:
          row.oldestPurgeDeadlineAt === null
            ? null
            : row.oldestPurgeDeadlineAt instanceof Date
              ? row.oldestPurgeDeadlineAt
              : new Date(row.oldestPurgeDeadlineAt),
        maximumOverdueSeconds: row.maximumOverdueSeconds,
      };
    });
  }
}

export async function expireInterviewIfNeeded(
  executor: DatabaseExecutor,
  input: {
    readonly interviewId: InterviewId;
    readonly accountId?: AccountId;
    readonly expectedVersion?: number;
  },
): Promise<InterviewExpiryResult> {
  const updated = await executor
    .update(interviewSessions)
    .set({
      status: "abandoned",
      activePhase: null,
      version: sql`${interviewSessions.version} + 1`,
      pendingOperationId: null,
      pendingOperationKind: null,
      pendingOperationQuestionPosition: null,
      pendingOperationAcceptedAt: null,
      pendingOperationPreviousPhase: null,
      pendingReportKind: null,
      reportRequestedAt: null,
      endedAt: databaseStatementTime,
    })
    .where(
      and(
        eq(interviewSessions.id, input.interviewId),
        input.accountId === undefined
          ? sql`true`
          : eq(interviewSessions.ownerUserId, input.accountId),
        eq(interviewSessions.status, "active"),
        sql`${databaseStatementTime} - ${interviewSessions.lastEffectiveActivityAt} > interval '24 hours'`,
      ),
    )
    .returning({
      version: interviewSessions.version,
      expiredAt: interviewSessions.endedAt,
    });
  const expired = updated[0];
  if (expired !== undefined && expired.expiredAt !== null) {
    const cancelledOperationCount = await cancelOpenOperations(executor, {
      interviewId: input.interviewId,
      errorCode: "interview_expired",
    });
    const previousVersion = expired.version - 1;
    return {
      kind: "expired",
      interviewId: input.interviewId,
      previousVersion,
      version: expired.version,
      expiredAt: expired.expiredAt,
      cancelledOperationCount,
      expectedVersionMatches:
        input.expectedVersion === undefined ? null : input.expectedVersion === previousVersion,
    };
  }

  const currentRows = await executor
    .select({
      status: interviewSessions.status,
      version: interviewSessions.version,
      endedAt: interviewSessions.endedAt,
    })
    .from(interviewSessions)
    .where(
      and(
        eq(interviewSessions.id, input.interviewId),
        input.accountId === undefined
          ? sql`true`
          : eq(interviewSessions.ownerUserId, input.accountId),
      ),
    )
    .limit(1);
  const current = currentRows[0];
  if (current === undefined) {
    return { kind: "not_found", interviewId: input.interviewId };
  }
  return {
    kind: "unchanged",
    interviewId: input.interviewId,
    status: current.status,
    version: current.version,
    endedAt: current.endedAt,
    expectedVersionMatches:
      input.expectedVersion === undefined ? null : input.expectedVersion === current.version,
  };
}

async function cancelOpenOperations(
  executor: DatabaseExecutor,
  input:
    | { readonly interviewId: InterviewId; readonly errorCode: string }
    | { readonly accountId: AccountId; readonly errorCode: string },
): Promise<number> {
  const rows = await executor
    .update(operations)
    .set({
      status: "failed",
      result: null,
      error: { code: input.errorCode },
      leaseAcquiredAt: null,
      leaseExpiresAt: null,
      leaseOwner: null,
      leaseTokenHash: null,
      completedLeaseOwner: sql`coalesce(${operations.leaseOwner}, 'interview-lifecycle')`,
      completedLeaseTokenHash: sql`coalesce(${operations.leaseTokenHash}, ${systemCompletionTokenHash})`,
      retryable: false,
      completedAt: databaseStatementTime,
      updatedAt: databaseStatementTime,
    })
    .where(
      and(
        "interviewId" in input
          ? eq(operations.interviewId, input.interviewId)
          : eq(operations.ownerUserId, input.accountId),
        inArray(operations.status, ["pending", "processing"]),
      ),
    )
    .returning({ id: operations.id });
  return rows.length;
}

async function findInterviewDeletionRequest(
  executor: DatabaseExecutor,
  interviewId: InterviewId,
  accountId: AccountId,
) {
  const rows = await executor
    .select()
    .from(deletionRequests)
    .where(
      and(
        eq(deletionRequests.scope, "interview"),
        eq(deletionRequests.interviewId, interviewId),
        eq(deletionRequests.ownerUserId, accountId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

function deletionResult(
  request: typeof deletionRequests.$inferSelect,
  created: boolean,
  affectedInterviewCount: number,
  cancelledOperationCount: number,
): MarkDeletionResult {
  return {
    requestId: request.id,
    scope: request.scope,
    ownerUserId: request.ownerUserId,
    interviewId: request.interviewId,
    requestedAt: request.requestedAt,
    purgeDueAt: request.purgeDueAt,
    purgeDeadlineAt: request.purgeDeadlineAt,
    created,
    affectedInterviewCount,
    cancelledOperationCount,
  };
}

function requiredRow<Row>(rows: readonly Row[], resource: string): Row {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Failed to persist ${resource}`);
  }
  return row;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function validateBatchSize(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new RangeError("Batch size must be an integer from 1 through 1000");
  }
  return value;
}

function validateLeaseOwner(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 128) {
    throw new RangeError("Lease owner must contain 1 through 128 characters");
  }
  return normalized;
}

function validatePurgeLeaseDuration(value: number): number {
  if (
    !Number.isInteger(value) ||
    value < MINIMUM_PURGE_LEASE_DURATION_MS ||
    value > 24 * 60 * 60 * 1_000
  ) {
    throw new RangeError(
      "lease duration must be an integer from 30000 through 86400000 milliseconds",
    );
  }
  return value;
}

function validateRetryDelay(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 60_000 || value > 24 * 60 * 60 * 1_000) {
    throw new RangeError(`${field} must be an integer from 60000 through 86400000 milliseconds`);
  }
  return value;
}

function validateErrorPart(value: string, maximumLength: number, field: string): string {
  if (value.length < 1 || value.length > maximumLength || !/^[a-z0-9_]+$/.test(value)) {
    throw new RangeError(`${field} must be a bounded lowercase identifier`);
  }
  return value;
}

function validateSubjectHash(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new RangeError("Purge subject identifier hash must be lowercase SHA-256 hex");
  }
}

function verificationOwnedByAccount(ownerUserId: string, email: string) {
  const exactOtpIdentifiers = [
    `email-verification-otp-${email}`,
    `sign-in-otp-${email}`,
    `forget-password-otp-${email}`,
  ];
  return or(
    inArray(verification.identifier, exactOtpIdentifiers),
    sql`starts_with(${verification.identifier}, ${`change-email-otp-${email}-`})`,
    sql`safe_verification_value_jsonb(${verification.value}) #>> '{link,userId}' = ${ownerUserId}`,
    sql`safe_verification_value_jsonb(${verification.value}) #>> '{link,email}' = ${email}`,
  );
}
