import type { ClaimedOperation, StoredOperation } from "@interview-agent/db";

export const DEFAULT_OPERATION_LEASE_MS = 5 * 60 * 1_000;

export function operationClaimInput(
  operation: StoredOperation,
  leaseOwner: string,
  leaseDurationMs: number,
  leaseExpiresAt?: Date,
) {
  return {
    operationId: operation.id,
    accountId: operation.accountId,
    leaseOwner,
    leaseDurationMs,
    ...(leaseExpiresAt === undefined ? {} : { leaseExpiresAt }),
  };
}

export function completionLease(claimed: ClaimedOperation) {
  return {
    leaseOwner: claimed.leaseOwner,
    leaseToken: claimed.leaseToken,
    attemptCount: claimed.attemptCount,
  };
}
