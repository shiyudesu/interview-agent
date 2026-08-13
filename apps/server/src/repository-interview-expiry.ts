import { RepositoryInterviewExpiredError } from "@interview-agent/db";

export async function retryAfterRepositoryInterviewExpiry<Result>(
  freshTransaction: () => Promise<Result>,
): Promise<Result> {
  try {
    return await freshTransaction();
  } catch (error) {
    if (!(error instanceof RepositoryInterviewExpiredError)) {
      throw error;
    }
    return freshTransaction();
  }
}
