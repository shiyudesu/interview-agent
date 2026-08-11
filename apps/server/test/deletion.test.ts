import { parseAccountId, parseInterviewId } from "@interview-agent/domain";
import { describe, expect, it, vi } from "vitest";

import { DeletionOrchestrationService, DeletionTargetNotFoundError } from "../src/deletion.js";

describe("DeletionOrchestrationService", () => {
  const accountId = parseAccountId("owner-1");
  const interviewId = parseInterviewId("interview-1");
  const deletionResult = {
    requestId: "deletion-1",
    scope: "interview" as const,
    ownerUserId: accountId,
    interviewId,
    requestedAt: new Date("2026-08-11T00:00:00.000Z"),
    purgeDueAt: new Date("2026-08-17T00:00:00.000Z"),
    purgeDeadlineAt: new Date("2026-08-18T00:00:00.000Z"),
    created: true,
    affectedInterviewCount: 1,
    cancelledOperationCount: 0,
  };

  it("passes authenticated ownership into interview and account deletion", async () => {
    const markInterviewDeleting = vi.fn(async () => deletionResult);
    const accountResult = { ...deletionResult, scope: "account" as const, interviewId: null };
    const markAccountDeleting = vi.fn(async () => accountResult);
    const service = new DeletionOrchestrationService({
      markInterviewDeleting,
      markAccountDeleting,
    });

    await expect(service.deleteInterview(accountId, interviewId)).resolves.toBe(deletionResult);
    await expect(service.deleteAccount(accountId)).resolves.toBe(accountResult);
    expect(markInterviewDeleting).toHaveBeenCalledWith(interviewId, accountId);
    expect(markAccountDeleting).toHaveBeenCalledWith(accountId);
  });

  it("does not distinguish missing and non-owned interview deletion targets", async () => {
    const service = new DeletionOrchestrationService({
      markInterviewDeleting: async () => null,
      markAccountDeleting: async () => null,
    });

    await expect(service.deleteInterview(accountId, interviewId)).rejects.toEqual(
      new DeletionTargetNotFoundError("interview"),
    );
    await expect(service.deleteAccount(accountId)).rejects.toEqual(
      new DeletionTargetNotFoundError("account"),
    );
  });
});
