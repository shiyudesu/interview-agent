import "@testing-library/jest-dom/vitest";

import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../src/lib/query-client.js";
import { HistoryPage } from "../src/pages/history-page.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("interview history", () => {
  it("renders completed, early-ended, and abandoned entries and appends cursor pages", async () => {
    const user = userEvent.setup();
    const requestFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/v1/account") {
        return jsonResponse(accountFixture());
      }
      if (url === "/api/v1/interviews?limit=20") {
        return jsonResponse({
          items: [
            historyItem("interview-complete", "completed"),
            historyItem("interview-early", "early_ended"),
            historyItem("interview-abandoned", "abandoned"),
          ],
          pageInfo: { hasMore: true, nextCursor: "cursor-next" },
        });
      }
      if (url === "/api/v1/interviews?limit=20&cursor=cursor-next") {
        return jsonResponse({
          items: [historyItem("interview-older", "completed")],
          pageInfo: { hasMore: false, nextCursor: null },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", requestFetch);
    renderHistory();

    expect(await screen.findByText("已完成")).toBeInTheDocument();
    expect(screen.getByText("提前结束")).toBeInTheDocument();
    expect(screen.getByText("已放弃")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "查看面试记录" })).toHaveLength(3);
    expect(screen.getAllByRole("link", { name: "查看报告" })).toHaveLength(2);
    expect(screen.getByText("88")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "加载更多" }));

    await waitFor(() =>
      expect(screen.getAllByRole("link", { name: "查看面试记录" })).toHaveLength(4),
    );
    expect(requestFetch).toHaveBeenCalledWith(
      "/api/v1/interviews?limit=20&cursor=cursor-next",
      expect.any(Object),
    );
  });
});

function renderHistory() {
  const router = createMemoryRouter([{ path: "/history", element: <HistoryPage /> }], {
    initialEntries: ["/history"],
  });
  render(
    <QueryClientProvider client={createAppQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function accountFixture() {
  return {
    id: "account-history",
    email: "candidate@example.test",
    displayName: "候选人",
    linkedIdentities: [],
    sessions: [],
    createdAt: "2026-08-14T00:00:00.000Z",
  };
}

function historyItem(id: string, status: "completed" | "early_ended" | "abandoned") {
  const common = {
    id,
    status,
    direction: "go_backend",
    questionCount: 5,
    startedAt: "2026-08-13T00:00:00.000Z",
    endedAt: "2026-08-13T01:00:00.000Z",
  };
  if (status === "completed") {
    return { ...common, overallScore: 88, reportId: `report-${id}` };
  }
  if (status === "early_ended") {
    return { ...common, reportId: `report-${id}` };
  }
  return common;
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
