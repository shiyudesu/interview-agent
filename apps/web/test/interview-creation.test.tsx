import "@testing-library/jest-dom/vitest";

import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../src/lib/query-client.js";
import { InterviewCreationPage } from "../src/pages/interview-creation-page.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("interview creation", () => {
  it("shows the sign-in action when the account session is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: "unauthorized",
              message: "Authentication required",
            },
          },
          401,
        ),
      ),
    );
    renderCreationRoute();

    expect(await screen.findByRole("heading", { name: "需要登录" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "前往登录" })).toHaveAttribute("href", "/sign-in");
  });

  it("creates only a supported fixed Go interview size and resumes the accepted interview", async () => {
    const user = userEvent.setup();
    let created = false;
    const requestFetch = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/v1/account") {
        return jsonResponse(accountFixture(), 200);
      }
      if (url === "/api/v1/interviews/active") {
        return created
          ? jsonResponse(activeInterviewFixture("interview-created", 10), 200)
          : notFoundInterview();
      }
      if (url === "/api/v1/interviews" && init?.method === "POST") {
        created = true;
        return jsonResponse(operationFixture("operation-create"), 202);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", requestFetch);
    renderCreationRoute();

    await user.click(await screen.findByRole("radio", { name: /10 题/u }));
    await user.click(screen.getByRole("button", { name: "开始 10 题面试" }));

    expect(
      await screen.findByRole("heading", { name: "Active interview route" }),
    ).toBeInTheDocument();
    const createCall = requestFetch.mock.calls.find(
      ([url, init]) => url === "/api/v1/interviews" && init?.method === "POST",
    );
    expect(new Headers(createCall?.[1]?.headers).get("idempotency-key")).toEqual(
      expect.any(String),
    );
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      expectedVersion: 0,
      questionCount: 10,
    });
  });

  it("requires resuming or abandoning an existing active interview before creating another", async () => {
    const user = userEvent.setup();
    let active = true;
    const requestFetch = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/v1/account") {
        return jsonResponse(accountFixture(), 200);
      }
      if (url === "/api/v1/interviews/active") {
        return active
          ? jsonResponse(activeInterviewFixture("interview-active", 5), 200)
          : notFoundInterview();
      }
      if (url === "/api/v1/interviews/interview-active/abandon" && init?.method === "POST") {
        active = false;
        return jsonResponse(operationFixture("operation-abandon"), 200);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", requestFetch);
    renderCreationRoute();

    expect(
      await screen.findByRole("heading", { name: "你已有一场未结束的面试" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "恢复当前面试" })).toHaveAttribute(
      "href",
      "/interviews/interview-active",
    );
    await user.click(screen.getByRole("button", { name: "放弃并创建新面试" }));

    expect(
      await screen.findByRole("heading", { name: "创建 Go 后端模拟面试" }),
    ).toBeInTheDocument();
    const abandonCall = requestFetch.mock.calls.find(([url]) => String(url).includes("/abandon"));
    expect(JSON.parse(String(abandonCall?.[1]?.body))).toEqual({
      expectedVersion: 3,
    });
  });

  it("reuses the same idempotency key after an ambiguous create failure", async () => {
    const user = userEvent.setup();
    let createAttempts = 0;
    const keys: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === "/api/v1/account") {
          return jsonResponse(accountFixture(), 200);
        }
        if (url === "/api/v1/interviews/active") {
          return notFoundInterview();
        }
        if (url === "/api/v1/interviews" && init?.method === "POST") {
          createAttempts += 1;
          keys.push(new Headers(init.headers).get("idempotency-key") ?? "");
          if (createAttempts === 1) {
            throw new TypeError("connection closed");
          }
          return jsonResponse(operationFixture("operation-replayed"), 200);
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    renderCreationRoute();

    const start = await screen.findByRole("button", { name: "开始 5 题面试" });
    await user.click(start);
    expect(await screen.findByRole("alert")).toHaveTextContent("connection closed");
    await user.click(screen.getByRole("button", { name: "开始 5 题面试" }));

    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("does not offer abandonment while report generation is pending", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockImplementation(async (input) =>
          String(input) === "/api/v1/account"
            ? jsonResponse(accountFixture(), 200)
            : jsonResponse(reportPendingFixture(), 200),
        ),
    );
    renderCreationRoute();

    expect(
      await screen.findByRole("heading", { name: "你已有一场未结束的面试" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "恢复当前面试" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "放弃并创建新面试" })).not.toBeInTheDocument();
  });
});

function renderCreationRoute() {
  const router = createMemoryRouter(
    [
      { path: "/app", element: <InterviewCreationPage /> },
      { path: "/interviews/:interviewId", element: <h1>Active interview route</h1> },
    ],
    { initialEntries: ["/app"] },
  );
  render(
    <QueryClientProvider client={createAppQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function accountFixture() {
  return {
    id: "account-create",
    email: "candidate@example.test",
    displayName: "候选人",
    linkedIdentities: [],
    sessions: [],
    createdAt: "2026-08-14T00:00:00.000Z",
  };
}

function activeInterviewFixture(id: string, total: 5 | 10) {
  return {
    id,
    status: "active",
    version: 3,
    phase: "awaiting_response",
    progress: { current: 1, total },
    currentWording: "请说明 Go Context 的取消传播机制。",
    messages: [
      {
        id: `message-${id}`,
        role: "interviewer",
        kind: "main_question",
        text: "请说明 Go Context 的取消传播机制。",
        createdAt: "2026-08-14T00:00:00.000Z",
      },
    ],
    availableActions: ["abandon"],
    startedAt: "2026-08-14T00:00:00.000Z",
    lastEffectiveActivityAt: "2026-08-14T00:00:00.000Z",
    expiresAt: "2026-08-15T00:00:00.000Z",
  };
}

function operationFixture(operationId: string) {
  return {
    operationId,
    status: "succeeded",
    result: {
      interviewId: "interview-created",
      interviewVersion: 1,
      reportId: null,
    },
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
}

function reportPendingFixture() {
  return {
    id: "interview-report-pending",
    status: "report_pending",
    reportKind: "complete",
    version: 11,
    progress: { current: 5, total: 5 },
    messages: [],
    availableActions: [],
    startedAt: "2026-08-14T00:00:00.000Z",
    lastEffectiveActivityAt: "2026-08-14T00:20:00.000Z",
    expiresAt: "2026-08-15T00:20:00.000Z",
  };
}

function notFoundInterview() {
  return jsonResponse(
    {
      error: {
        code: "not_found",
        message: "Interview not found",
        resource: "interview",
      },
    },
    404,
  );
}

function jsonResponse(value: unknown, status: number) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
