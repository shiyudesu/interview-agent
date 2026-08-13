import { RepositoryInterviewExpiredError } from "@interview-agent/db";
import { describe, expect, it, vi } from "vitest";

import { retryAfterRepositoryInterviewExpiry } from "../src/repository-interview-expiry.js";

const expired = new RepositoryInterviewExpiredError(
  "interview-1",
  1,
  2,
  new Date("2026-08-12T00:00:00.000Z"),
);

describe("repository interview expiry retry", () => {
  it("retries exactly once with the caller-provided fresh transaction closure", async () => {
    const freshTransaction = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(expired)
      .mockResolvedValueOnce("canonical result");

    await expect(retryAfterRepositoryInterviewExpiry(freshTransaction)).resolves.toBe(
      "canonical result",
    );
    expect(freshTransaction).toHaveBeenCalledTimes(2);
  });

  it("does not retry unrelated failures", async () => {
    const failure = new Error("database failure");
    const freshTransaction = vi.fn<() => Promise<never>>().mockRejectedValue(failure);

    await expect(retryAfterRepositoryInterviewExpiry(freshTransaction)).rejects.toBe(failure);
    expect(freshTransaction).toHaveBeenCalledTimes(1);
  });

  it("propagates a second expiry failure without a third attempt", async () => {
    const freshTransaction = vi.fn<() => Promise<never>>().mockRejectedValue(expired);

    await expect(retryAfterRepositoryInterviewExpiry(freshTransaction)).rejects.toBe(expired);
    expect(freshTransaction).toHaveBeenCalledTimes(2);
  });
});
