import "@testing-library/jest-dom/vitest";

import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../src/lib/query-client.js";
import { ActiveInterviewPage } from "../src/pages/active-interview-page.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("active interview screen", () => {
  it("submits an answer and disables invalid actions from canonical permissions", async () => {
    const user = userEvent.setup();
    let detail = awaitingResponseFixture();
    const requestFetch = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/v1/account") {
        return jsonResponse(accountFixture(), 200);
      }
      if (url === "/api/v1/interviews/interview-active" && init?.method === "GET") {
        return jsonResponse(detail, 200);
      }
      if (url === "/api/v1/interviews/interview-active/answers" && init?.method === "POST") {
        detail = processingFixture();
        return jsonResponse(pendingOperation("operation-answer"), 202);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", requestFetch);
    renderInterview();

    expect(await screen.findByText("第 1 / 5 题")).toBeInTheDocument();
    expect(screen.getByText("系统追问")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "澄清题意" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "继续下一题" })).toBeDisabled();

    await user.type(
      screen.getByRole("textbox", { name: "你的回答" }),
      "父 Context 会向下取消子 Context。",
    );
    await user.click(screen.getByRole("button", { name: "提交回答" }));

    expect(await screen.findByText(/页面刷新不会中断处理/u)).toBeInTheDocument();
    const answerCall = requestFetch.mock.calls.find(([url]) => String(url).endsWith("/answers"));
    expect(JSON.parse(String(answerCall?.[1]?.body))).toEqual({
      expectedVersion: 4,
      text: "父 Context 会向下取消子 Context。",
    });
    expect(new Headers(answerCall?.[1]?.headers).get("idempotency-key")).toEqual(
      expect.any(String),
    );
  });

  it("shows the supplement window and advances only through explicit continue", async () => {
    const user = userEvent.setup();
    let detail = awaitingContinueFixture();
    const requestFetch = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/v1/account") {
        return jsonResponse(accountFixture(), 200);
      }
      if (url === "/api/v1/interviews/interview-active" && init?.method === "GET") {
        return jsonResponse(detail, 200);
      }
      if (url === "/api/v1/interviews/interview-active/continue" && init?.method === "POST") {
        detail = nextQuestionFixture();
        return jsonResponse(succeededOperation("operation-continue", 8), 200);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", requestFetch);
    renderInterview();

    const supplement = await screen.findByRole("textbox", { name: "补充回答" });
    expect(screen.getByRole("button", { name: "澄清题意" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "跳过本题" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "继续下一题" })).toBeEnabled();

    await user.type(supplement, "这段草稿不应进入下一题。");
    await user.click(screen.getByRole("button", { name: "继续下一题" }));

    expect(await screen.findByText("第 2 / 5 题")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "请说明 Go channel 的关闭语义。" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "你的回答" })).toHaveValue("");
    const continueCall = requestFetch.mock.calls.find(([url]) => String(url).endsWith("/continue"));
    expect(JSON.parse(String(continueCall?.[1]?.body))).toEqual({ expectedVersion: 7 });
  });

  it("retries only a failed report Operation from report-pending state", async () => {
    const user = userEvent.setup();
    let retried = false;
    const requestFetch = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/v1/account") {
        return jsonResponse(accountFixture(), 200);
      }
      if (url === "/api/v1/interviews/interview-active" && init?.method === "GET") {
        return jsonResponse(
          retried ? reportPendingProcessingFixture() : reportPendingRetryFixture(),
          200,
        );
      }
      if (url === "/api/v1/interviews/interview-active/retry" && init?.method === "POST") {
        retried = true;
        return jsonResponse(pendingOperation("operation-report"), 202);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", requestFetch);
    renderInterview();

    await user.click(await screen.findByRole("button", { name: "重试报告生成" }));

    expect(await screen.findByText(/已完成的题目和评价不会重新执行/u)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试报告生成" })).not.toBeInTheDocument();
    const retryCall = requestFetch.mock.calls.find(([url]) => String(url).endsWith("/retry"));
    expect(JSON.parse(String(retryCall?.[1]?.body))).toEqual({
      expectedVersion: 12,
      operationId: "operation-report",
    });
  });

  it("shows a busy state when an awaiting-response interview owns a pending Operation", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockImplementation(async (input) =>
          String(input) === "/api/v1/account"
            ? jsonResponse(accountFixture(), 200)
            : jsonResponse(awaitingResponsePendingFixture(), 200),
        ),
    );
    renderInterview();

    expect(await screen.findByText("正在处理")).toBeInTheDocument();
    expect(screen.getByText(/页面刷新不会中断处理/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "澄清题意" })).toBeDisabled();
  });

  it("resumes a processing Operation stream and reloads canonical state on terminal events", async () => {
    let detail = processingFixture();
    const requestFetch = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/v1/account") {
        return jsonResponse(accountFixture(), 200);
      }
      if (url === "/api/v1/interviews/interview-active" && init?.method === "GET") {
        return jsonResponse(detail, 200);
      }
      if (url === "/api/v1/operations/operation-answer/events") {
        detail = awaitingContinueFixture();
        return new Response(
          `id: 1\nevent: succeeded\ndata: ${JSON.stringify({
            operationId: "operation-answer",
            sequence: 1,
            occurredAt: "2026-08-14T00:02:00.000Z",
            type: "succeeded",
          })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", requestFetch);
    renderInterview();

    expect(await screen.findByRole("textbox", { name: "补充回答" })).toBeInTheDocument();
    expect(
      requestFetch.mock.calls.some(([url]) => url === "/api/v1/operations/operation-answer/events"),
    ).toBe(true);
  });

  it("rotates a retry key when canonical state remains a retryable failed Operation", async () => {
    const user = userEvent.setup();
    const keys: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === "/api/v1/account") {
          return jsonResponse(accountFixture(), 200);
        }
        if (url === "/api/v1/interviews/interview-active" && init?.method === "GET") {
          return jsonResponse(reportPendingRetryFixture(), 200);
        }
        if (url.endsWith("/retry") && init?.method === "POST") {
          keys.push(new Headers(init.headers).get("idempotency-key") ?? "");
          throw new TypeError("connection closed");
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    renderInterview();

    await user.click(await screen.findByRole("button", { name: "重试报告生成" }));
    expect(await screen.findByText("connection closed")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试报告生成" }));

    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("clears an old-version answer after ambiguous acceptance advances to a follow-up", async () => {
    const user = userEvent.setup();
    let accepted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === "/api/v1/account") {
          return jsonResponse(accountFixture(), 200);
        }
        if (url === "/api/v1/interviews/interview-active" && init?.method === "GET") {
          return jsonResponse(accepted ? followUpFixture() : awaitingResponseFixture(), 200);
        }
        if (url.endsWith("/answers") && init?.method === "POST") {
          accepted = true;
          throw new TypeError("connection closed");
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    renderInterview();

    const response = await screen.findByRole("textbox", { name: "你的回答" });
    await user.type(response, "这段回答已经被服务端接受。");
    await user.click(screen.getByRole("button", { name: "提交回答" }));

    expect(await screen.findByText("请补充说明取消传播方向。")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "你的回答" })).toHaveValue("");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders completed transcript detail as immutable history", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockImplementation(async (input) =>
          String(input) === "/api/v1/account"
            ? jsonResponse(accountFixture(), 200)
            : jsonResponse(completedInterviewFixture(), 200),
        ),
    );
    renderInterview();

    expect(await screen.findByText("已完成")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看完整报告" })).toHaveAttribute(
      "href",
      "/reports/interview-active",
    );
    expect(screen.getByText("候选人的历史回答。")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});

function renderInterview() {
  const router = createMemoryRouter(
    [{ path: "/interviews/:interviewId", element: <ActiveInterviewPage /> }],
    { initialEntries: ["/interviews/interview-active"] },
  );
  render(
    <QueryClientProvider client={createAppQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function accountFixture() {
  return {
    id: "account-active",
    email: "candidate@example.test",
    displayName: "候选人",
    linkedIdentities: [],
    sessions: [],
    createdAt: "2026-08-14T00:00:00.000Z",
  };
}

function awaitingResponseFixture() {
  return activeFixture({
    version: 4,
    phase: "awaiting_response",
    availableActions: [
      "submit_answer",
      "request_clarification",
      "mark_unknown",
      "skip",
      "end_early",
      "abandon",
    ],
    messages: [
      message("message-question", "interviewer", "main_question", "请说明 Context 的取消传播。"),
      message("message-follow-up", "interviewer", "follow_up", "取消方向是怎样的？"),
    ],
  });
}

function processingFixture() {
  return activeFixture({
    version: 5,
    phase: "processing",
    availableActions: [],
    operation: { operationId: "operation-answer", status: "processing" },
    messages: [
      message("message-question", "interviewer", "main_question", "请说明 Context 的取消传播。"),
      message("message-follow-up", "interviewer", "follow_up", "取消方向是怎样的？"),
    ],
  });
}

function awaitingResponsePendingFixture() {
  return activeFixture({
    version: 1,
    phase: "awaiting_response",
    availableActions: [],
    operation: { operationId: "operation-create", status: "processing" },
    messages: [],
  });
}

function awaitingContinueFixture() {
  return activeFixture({
    version: 7,
    phase: "awaiting_continue",
    availableActions: ["submit_supplement", "continue", "end_early", "abandon"],
    messages: [
      message("message-question", "interviewer", "main_question", "请说明 Context 的取消传播。"),
      message("message-answer", "user", "answer", "父 Context 会向下传播取消。"),
    ],
  });
}

function followUpFixture() {
  return activeFixture({
    version: 5,
    phase: "awaiting_response",
    availableActions: [
      "submit_answer",
      "request_clarification",
      "mark_unknown",
      "skip",
      "end_early",
      "abandon",
    ],
    messages: [
      message("message-question", "interviewer", "main_question", "请说明 Context 的取消传播。"),
      message("message-answer", "user", "answer", "这段回答已经被服务端接受。"),
      message("message-follow-up", "interviewer", "follow_up", "请补充说明取消传播方向。"),
    ],
  });
}

function nextQuestionFixture() {
  return {
    ...activeFixture({
      version: 8,
      phase: "awaiting_response",
      availableActions: [
        "submit_answer",
        "request_clarification",
        "mark_unknown",
        "skip",
        "end_early",
        "abandon",
      ],
      messages: [
        message(
          "message-question-2",
          "interviewer",
          "main_question",
          "请说明 Go channel 的关闭语义。",
        ),
      ],
    }),
    progress: { current: 2, total: 5 },
    currentWording: "请说明 Go channel 的关闭语义。",
  };
}

function activeFixture(input: {
  readonly availableActions: readonly string[];
  readonly messages: readonly ReturnType<typeof message>[];
  readonly operation?: { readonly operationId: string; readonly status: "processing" };
  readonly phase: "awaiting_response" | "processing" | "awaiting_continue";
  readonly version: number;
}) {
  return {
    id: "interview-active",
    status: "active",
    version: input.version,
    phase: input.phase,
    progress: { current: 1, total: 5 },
    currentWording: "请说明 Context 的取消传播。",
    messages: input.messages,
    ...(input.operation === undefined ? {} : { operation: input.operation }),
    availableActions: input.availableActions,
    startedAt: "2026-08-14T00:00:00.000Z",
    lastEffectiveActivityAt: "2026-08-14T00:00:00.000Z",
    expiresAt: "2026-08-15T00:00:00.000Z",
  };
}

function message(
  id: string,
  role: "user" | "interviewer",
  kind: "main_question" | "answer" | "follow_up",
  text: string,
) {
  return {
    id,
    role,
    kind,
    text,
    createdAt: "2026-08-14T00:00:00.000Z",
  };
}

function pendingOperation(operationId: string) {
  return {
    operationId,
    status: "processing",
    createdAt: "2026-08-14T00:01:00.000Z",
    updatedAt: "2026-08-14T00:01:00.000Z",
  };
}

function succeededOperation(operationId: string, interviewVersion: number) {
  return {
    operationId,
    status: "succeeded",
    result: {
      interviewId: "interview-active",
      interviewVersion,
      reportId: null,
    },
    createdAt: "2026-08-14T00:01:00.000Z",
    updatedAt: "2026-08-14T00:01:00.000Z",
  };
}

function reportPendingRetryFixture() {
  return {
    id: "interview-active",
    status: "report_pending",
    reportKind: "complete",
    version: 12,
    progress: { current: 5, total: 5 },
    messages: [],
    operation: {
      operationId: "operation-report",
      status: "failed",
      failure: {
        code: "model_failure",
        message: "Report analysis failed",
        retryable: true,
      },
    },
    availableActions: ["retry"],
    startedAt: "2026-08-14T00:00:00.000Z",
    lastEffectiveActivityAt: "2026-08-14T00:20:00.000Z",
    expiresAt: "2026-08-15T00:20:00.000Z",
  };
}

function reportPendingProcessingFixture() {
  return {
    ...reportPendingRetryFixture(),
    operation: {
      operationId: "operation-report",
      status: "processing",
    },
    availableActions: [],
  };
}

function completedInterviewFixture() {
  return {
    id: "interview-active",
    status: "completed",
    version: 14,
    questionCount: 5,
    reportId: "report-complete",
    startedAt: "2026-08-14T00:00:00.000Z",
    endedAt: "2026-08-14T01:00:00.000Z",
    messages: [
      message("message-history-question", "interviewer", "main_question", "历史问题。"),
      message("message-history-answer", "user", "answer", "候选人的历史回答。"),
    ],
  };
}

function jsonResponse(value: unknown, status: number) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
