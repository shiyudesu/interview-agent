import type { AccountId, InterviewId } from "@interview-agent/domain";

export class RepositoryInterviewExpirySignal extends Error {
  constructor(
    readonly interviewId: InterviewId,
    readonly accountId: AccountId | undefined,
    readonly expectedVersion: number,
  ) {
    super(`Interview ${interviewId} requires authoritative expiry persistence`);
    this.name = "RepositoryInterviewExpirySignal";
  }
}
