import { createHmac } from "node:crypto";
import type { AccountId, InterviewId } from "@interview-agent/domain";

import type {
  ClaimedDeletionRequest,
  DeletionOverdueProjection,
  InterviewExpiryResult,
  MarkDeletionResult,
  PgLifecycleRepository,
  PurgeFailure,
} from "../repositories/lifecycle-repository.js";

export interface LifecycleServiceOptions {
  readonly purgeHashSecret: string;
  readonly expiryBatchSize?: number;
  readonly maximumExpiryBatchesPerCycle?: number;
  readonly purgeBatchSize?: number;
  readonly purgeLeaseOwner?: string;
  readonly purgeLeaseDurationMs?: number;
  readonly failedPurgeRetryDelayMs?: number;
  readonly maximumPurgeRequestsPerCycle?: number;
}

export interface PurgeSweepResult {
  readonly claimed: number;
  readonly succeeded: number;
  readonly failed: number;
}

export interface MaintenanceCycleResult {
  readonly expiredInterviews: number;
  readonly purge: PurgeSweepResult;
  readonly overdue: DeletionOverdueProjection;
}

export interface PeriodicMaintenanceOptions {
  readonly intervalMs: number;
  readonly runImmediately?: boolean;
  readonly onError?: (error: unknown) => void;
}

export interface PeriodicMaintenanceHandle {
  stop(): void;
}

export const MINIMUM_MAINTENANCE_INTERVAL_MS = 60_000;
export const MAXIMUM_MAINTENANCE_INTERVAL_MS = 2_147_483_647;

export class LifecycleService {
  private readonly purgeHashSecret: string;
  private readonly expiryBatchSize: number;
  private readonly maximumExpiryBatchesPerCycle: number;
  private readonly purgeBatchSize: number;
  private readonly purgeLeaseOwner: string;
  private readonly purgeLeaseDurationMs: number;
  private readonly failedPurgeRetryDelayMs: number;
  private readonly maximumPurgeRequestsPerCycle: number;

  constructor(
    private readonly repository: PgLifecycleRepository,
    options: LifecycleServiceOptions,
  ) {
    this.purgeHashSecret = validateHashSecret(options.purgeHashSecret);
    this.expiryBatchSize = validateBatchSize(options.expiryBatchSize ?? 50, "Expiry batch size");
    this.maximumExpiryBatchesPerCycle = validateCycleLimit(
      options.maximumExpiryBatchesPerCycle ?? 1_000,
      "Maximum expiry batches per cycle",
    );
    this.purgeBatchSize = validateBatchSize(options.purgeBatchSize ?? 20, "Purge batch size");
    this.purgeLeaseOwner = options.purgeLeaseOwner?.trim() || `lifecycle-${process.pid}`;
    this.purgeLeaseDurationMs = validatePurgeLeaseDuration(
      options.purgeLeaseDurationMs ?? 5 * 60_000,
    );
    this.failedPurgeRetryDelayMs = validateRetryDelay(
      options.failedPurgeRetryDelayMs ?? 5 * 60_000,
    );
    this.maximumPurgeRequestsPerCycle = validateCycleLimit(
      options.maximumPurgeRequestsPerCycle ?? 1_000,
      "Maximum purge requests per cycle",
    );
  }

  expireInterviewBeforeAccess(input: {
    readonly interviewId: InterviewId;
    readonly accountId?: AccountId;
    readonly expectedVersion?: number;
  }): Promise<InterviewExpiryResult> {
    return this.repository.expireInterviewIfNeeded(input);
  }

  async sweepExpiredInterviews(): Promise<number> {
    let expired = 0;
    for (let batch = 0; batch < this.maximumExpiryBatchesPerCycle; batch += 1) {
      const results = await this.repository.sweepExpiredBatch(this.expiryBatchSize);
      const transitioned = results.filter((result) => result.kind === "expired").length;
      expired += transitioned;
      if (results.length < this.expiryBatchSize || transitioned === 0) {
        return expired;
      }
    }
    return expired;
  }

  requestInterviewDeletion(
    interviewId: InterviewId,
    accountId: AccountId,
  ): Promise<MarkDeletionResult | null> {
    return this.repository.markInterviewDeleting(interviewId, accountId);
  }

  requestAccountDeletion(accountId: AccountId): Promise<MarkDeletionResult | null> {
    return this.repository.markAccountDeleting(accountId);
  }

  async sweepDuePurges(): Promise<PurgeSweepResult> {
    let claimedCount = 0;
    let succeeded = 0;
    let failed = 0;
    const attemptedRequestIds = new Set<string>();
    const attemptLimit = Math.min(this.purgeBatchSize, this.maximumPurgeRequestsPerCycle);

    while (claimedCount < attemptLimit) {
      const claims = await this.repository.claimDueDeletionRequests({
        batchSize: 1,
        leaseOwner: this.purgeLeaseOwner,
        leaseDurationMs: this.purgeLeaseDurationMs,
        failedRetryDelayMs: this.failedPurgeRetryDelayMs,
        excludedRequestIds: [...attemptedRequestIds],
      });
      const claim = claims[0];
      if (claim === undefined) {
        return { claimed: claimedCount, succeeded, failed };
      }
      attemptedRequestIds.add(claim.requestId);
      claimedCount += 1;

      let failure: PurgeFailure | null = null;
      try {
        const purged = await this.repository.purgeClaimedDeletionRequest(
          claim,
          createPurgeSubjectIdentifierHash(
            this.purgeHashSecret,
            claim.scope,
            purgeSubjectIdentifier(claim),
          ),
        );
        if (purged) {
          succeeded += 1;
        } else {
          failure = { category: "database", code: "purge_lease_lost" };
        }
      } catch (error) {
        failure = classifyPurgeFailure(error);
      }
      if (failure !== null) {
        failed += 1;
        const recorded = await this.repository.recordPurgeFailure(
          claim,
          failure,
          this.failedPurgeRetryDelayMs,
        );
        if (!recorded) {
          throw new Error(`Unable to persist purge failure for request ${claim.requestId}`);
        }
      }
    }
    return { claimed: claimedCount, succeeded, failed };
  }

  getDeletionOverdueProjection(): Promise<DeletionOverdueProjection> {
    return this.repository.getDeletionOverdueProjection();
  }

  async runMaintenanceCycle(): Promise<MaintenanceCycleResult> {
    const expiredInterviews = await this.sweepExpiredInterviews();
    const purge = await this.sweepDuePurges();
    const overdue = await this.getDeletionOverdueProjection();
    return { expiredInterviews, purge, overdue };
  }

  startPeriodicMaintenance(options: PeriodicMaintenanceOptions): PeriodicMaintenanceHandle {
    if (
      !Number.isInteger(options.intervalMs) ||
      options.intervalMs < MINIMUM_MAINTENANCE_INTERVAL_MS ||
      options.intervalMs > MAXIMUM_MAINTENANCE_INTERVAL_MS
    ) {
      throw new RangeError(
        `Maintenance interval must be an integer from ${MINIMUM_MAINTENANCE_INTERVAL_MS} through ${MAXIMUM_MAINTENANCE_INTERVAL_MS} milliseconds`,
      );
    }
    let stopped = false;
    let running = false;
    const run = async () => {
      if (stopped || running) {
        return;
      }
      running = true;
      try {
        await this.runMaintenanceCycle();
      } catch (error) {
        options.onError?.(error);
      } finally {
        running = false;
      }
    };
    if (options.runImmediately ?? true) {
      void run();
    }
    const timer = setInterval(() => void run(), options.intervalMs);
    timer.unref();
    return {
      stop() {
        stopped = true;
        clearInterval(timer);
      },
    };
  }
}

export function createPurgeSubjectIdentifierHash(
  secret: string,
  scope: "account" | "interview",
  identifier: string,
): string {
  return createHmac("sha256", validateHashSecret(secret))
    .update(scope)
    .update("\0")
    .update(identifier)
    .digest("hex");
}

function purgeSubjectIdentifier(claim: ClaimedDeletionRequest): string {
  if (claim.scope === "account") {
    return claim.ownerUserId;
  }
  if (claim.interviewId === null) {
    throw new Error("Interview deletion request has no interview identifier");
  }
  return claim.interviewId;
}

function classifyPurgeFailure(error: unknown): PurgeFailure {
  const postgresError = findPostgresError(error);
  if (postgresError !== null) {
    return {
      category: postgresError.code.startsWith("23") ? "constraint" : "database",
      code: `postgres_${postgresError.code.toLowerCase()}`,
    };
  }
  return { category: "unknown", code: "purge_failed" };
}

function findPostgresError(error: unknown): { readonly code: string } | null {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return null;
    }
    const candidate = current as { readonly cause?: unknown; readonly code?: unknown };
    if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return { code: candidate.code };
    }
    current = candidate.cause;
  }
  return null;
}

function validateHashSecret(secret: string): string {
  if (secret.length < 32) {
    throw new RangeError("Purge audit hash secret must contain at least 32 characters");
  }
  return secret;
}

function validateRetryDelay(value: number): number {
  if (!Number.isInteger(value) || value < 60_000 || value > 86_400_000) {
    throw new RangeError(
      "Failed purge retry delay must be an integer from 60000 through 86400000 milliseconds",
    );
  }
  return value;
}

function validatePurgeLeaseDuration(value: number): number {
  if (!Number.isInteger(value) || value < 30_000 || value > 86_400_000) {
    throw new RangeError(
      "Purge lease duration must be an integer from 30000 through 86400000 milliseconds",
    );
  }
  return value;
}

function validateBatchSize(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new RangeError(`${label} must be an integer from 1 through 1000`);
  }
  return value;
}

function validateCycleLimit(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 100_000) {
    throw new RangeError(`${label} must be an integer from 1 through 100000`);
  }
  return value;
}
