import { afterEach, describe, expect, it, vi } from "vitest";

import { runInterviewAction } from "../src/features/interview/interview-api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("interview action API", () => {
  it.each([
    { action: "submit_answer", endpoint: "answers", extra: { text: "回答内容" } },
    { action: "submit_supplement", endpoint: "supplements", extra: { text: "补充内容" } },
    { action: "request_clarification", endpoint: "clarifications", extra: {} },
    { action: "mark_unknown", endpoint: "unknown", extra: {} },
    { action: "skip", endpoint: "skip", extra: {} },
    { action: "continue", endpoint: "continue", extra: {} },
    { action: "end_early", endpoint: "end-early", extra: {} },
    { action: "abandon", endpoint: "abandon", extra: {} },
    { action: "retry", endpoint: "retry", extra: { operationId: "operation-failed" } },
  ] as const)("maps $action to its command endpoint", async ({ action, endpoint, extra }) => {
    const requestFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          operationId: "operation-result",
          status: "processing",
          createdAt: "2026-08-14T00:00:00.000Z",
          updatedAt: "2026-08-14T00:00:00.000Z",
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", requestFetch);

    await runInterviewAction({
      action,
      expectedVersion: 9,
      idempotencyKey: "logical-command-key",
      interviewId: "interview-action",
      ...extra,
    });

    const [url, init] = requestFetch.mock.calls[0] ?? [];
    expect(url).toBe(`/api/v1/interviews/interview-action/${endpoint}`);
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("logical-command-key");
    expect(JSON.parse(String(init?.body))).toEqual({
      expectedVersion: 9,
      ...extra,
    });
  });
});
