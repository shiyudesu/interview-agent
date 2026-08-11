import type { MarkDeletionResult } from "@interview-agent/db";
import type { AccountId, InterviewId } from "@interview-agent/domain";

export interface DeletionLifecycle {
  markInterviewDeleting(
    interviewId: InterviewId,
    accountId: AccountId,
  ): Promise<MarkDeletionResult | null>;
  markAccountDeleting(accountId: AccountId): Promise<MarkDeletionResult | null>;
}

export class DeletionTargetNotFoundError extends Error {
  constructor(readonly scope: "account" | "interview") {
    super(`${scope} deletion target was not found`);
    this.name = "DeletionTargetNotFoundError";
  }
}

export class DeletionOrchestrationService {
  constructor(private readonly lifecycle: DeletionLifecycle) {}

  async deleteInterview(
    accountId: AccountId,
    interviewId: InterviewId,
  ): Promise<MarkDeletionResult> {
    const result = await this.lifecycle.markInterviewDeleting(interviewId, accountId);
    if (result === null) {
      throw new DeletionTargetNotFoundError("interview");
    }
    return result;
  }

  async deleteAccount(accountId: AccountId): Promise<MarkDeletionResult> {
    const result = await this.lifecycle.markAccountDeleting(accountId);
    if (result === null) {
      throw new DeletionTargetNotFoundError("account");
    }
    return result;
  }
}
