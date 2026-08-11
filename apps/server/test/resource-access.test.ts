import { parseAccountId, parseInterviewId } from "@interview-agent/domain";
import { describe, expect, it, vi } from "vitest";

import { OwnedResourceNotFoundError, ResourceAccessService } from "../src/resource-access.js";

describe("ResourceAccessService", () => {
  const accountId = parseAccountId("owner-1");
  const interviewId = parseInterviewId("interview-1");

  it("passes owner scope to interview and report readers", async () => {
    const interview = { id: interviewId };
    const report = { id: "report-1" };
    const findInterview = vi.fn(async () => interview);
    const findReport = vi.fn(async () => report);
    const service = new ResourceAccessService(
      { findById: findInterview },
      { findByInterviewId: findReport },
    );

    await expect(service.requireInterview(accountId, interviewId)).resolves.toBe(interview);
    await expect(service.requireReport(accountId, interviewId)).resolves.toBe(report);
    expect(findInterview).toHaveBeenCalledWith(interviewId, accountId);
    expect(findReport).toHaveBeenCalledWith(interviewId, accountId);
  });

  it("uses the same not-found result for missing and non-owned resources", async () => {
    const service = new ResourceAccessService(
      { findById: async () => null },
      { findByInterviewId: async () => null },
    );

    await expect(service.requireInterview(accountId, interviewId)).rejects.toEqual(
      new OwnedResourceNotFoundError("interview"),
    );
    await expect(service.requireReport(accountId, interviewId)).rejects.toEqual(
      new OwnedResourceNotFoundError("report"),
    );
  });
});
