import type { AccountId, InterviewId } from "@interview-agent/domain";

import type { Database } from "../client.js";
import {
  RepositoryInterviewExpiredError,
  RepositoryNotFoundError,
  RepositoryVersionConflictError,
} from "./errors.js";
import { RepositoryInterviewExpirySignal } from "./interview-expiry.js";
import { expireInterviewIfNeeded, type InterviewExpiryResult } from "./lifecycle-repository.js";
import {
  type DatabaseExecutor,
  type RepositoryExecution,
  type TransactionOptions,
  withTransaction,
} from "./transaction.js";

type UnexpiredInterviewResult = Exclude<InterviewExpiryResult, { readonly kind: "expired" }>;

export async function expireInterviewOrSignal(
  executor: DatabaseExecutor,
  input: {
    readonly interviewId: InterviewId;
    readonly accountId?: AccountId;
    readonly expectedVersion?: number;
  },
): Promise<UnexpiredInterviewResult> {
  const expiry = await expireInterviewIfNeeded(executor, input);
  if (expiry.kind === "expired") {
    throw new RepositoryInterviewExpirySignal(
      input.interviewId,
      input.accountId,
      input.expectedVersion ?? expiry.previousVersion,
    );
  }
  return expiry;
}

export async function runRepositoryTransaction<Result>(
  execution: RepositoryExecution,
  callback: (executor: DatabaseExecutor) => Promise<Result>,
  options: TransactionOptions = {},
): Promise<Result> {
  try {
    return await execution.inTransaction(callback, options);
  } catch (error) {
    if (!(error instanceof RepositoryInterviewExpirySignal) || execution.transactionBound) {
      throw error;
    }
    return persistInterviewExpiryAndThrow(execution.database, error);
  }
}

export async function persistInterviewExpiryAndThrow(
  database: Database,
  signal: RepositoryInterviewExpirySignal,
): Promise<never> {
  const expiry = await withTransaction(database, (executor) =>
    expireInterviewIfNeeded(executor, {
      interviewId: signal.interviewId,
      ...(signal.accountId === undefined ? {} : { accountId: signal.accountId }),
      expectedVersion: signal.expectedVersion,
    }),
  );
  if (expiry.kind === "expired") {
    throw new RepositoryInterviewExpiredError(
      signal.interviewId,
      signal.expectedVersion,
      expiry.version,
      expiry.expiredAt,
    );
  }
  if (expiry.kind === "not_found") {
    throw new RepositoryNotFoundError("interview", signal.interviewId);
  }
  if (expiry.status === "abandoned" && expiry.endedAt !== null) {
    throw new RepositoryInterviewExpiredError(
      signal.interviewId,
      signal.expectedVersion,
      expiry.version,
      expiry.endedAt,
    );
  }
  throw new RepositoryVersionConflictError(
    signal.interviewId,
    signal.expectedVersion,
    expiry.version,
  );
}
