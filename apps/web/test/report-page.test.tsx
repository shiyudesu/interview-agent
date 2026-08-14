import "@testing-library/jest-dom/vitest";

import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../src/lib/query-client.js";
import { ReportPage } from "../src/pages/report-page.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("report views", () => {
  it("renders a complete report with score, domains, unassessed marker, and per-question feedback", async () => {
    renderReport(completeReportFixture());

    expect(await screen.findByRole("heading", { name: "完整面试报告" })).toBeInTheDocument();
    expect(screen.getByText("总分 / 100")).toBeInTheDocument();
    expect(screen.getAllByText("88").length).toBeGreaterThan(0);
    expect(screen.getByText("本场未评估")).toBeInTheDocument();
    expect(screen.getAllByText("缺失或错误知识点")).toHaveLength(5);
    expect(
      screen.getByText("本报告生成后保持只读，不支持重新评分、继续对话、导出或公开分享。"),
    ).toBeInTheDocument();
  });

  it("renders an incomplete report without inventing an overall score", async () => {
    renderReport(incompleteReportFixture());

    expect(await screen.findByRole("heading", { name: "不完整面试报告" })).toBeInTheDocument();
    expect(screen.getByText("不提供总分")).toBeInTheDocument();
    expect(screen.queryByText("总分 / 100")).not.toBeInTheDocument();
    expect(screen.getByText("未掌握")).toBeInTheDocument();
  });
});

function renderReport(report: unknown) {
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) =>
        String(input) === "/api/v1/account" ? jsonResponse(accountFixture()) : jsonResponse(report),
      ),
  );
  const router = createMemoryRouter([{ path: "/reports/:interviewId", element: <ReportPage /> }], {
    initialEntries: ["/reports/interview-report"],
  });
  render(
    <QueryClientProvider client={createAppQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function accountFixture() {
  return {
    id: "account-report",
    email: "candidate@example.test",
    displayName: "候选人",
    linkedIdentities: [],
    sessions: [],
    createdAt: "2026-08-14T00:00:00.000Z",
  };
}

function completeReportFixture() {
  return {
    ...reportBase("complete"),
    overallScore: 88,
    domains: domains(),
    questions: Array.from({ length: 5 }, (_, index) => scoredQuestion(index + 1)),
  };
}

function incompleteReportFixture() {
  return {
    ...reportBase("incomplete"),
    domains: incompleteDomains(),
    questions: [
      {
        ...questionBase(1),
        outcome: "unknown",
        score: 0,
        zeroScoreReason: "unknown",
        answerSummary: "明确表示暂未掌握。",
        matchedKnowledgePoints: [],
        missingOrIncorrectPoints: ["核心知识尚未获得作答证据。"],
      },
    ],
  };
}

function incompleteDomains() {
  return [
    { status: "assessed", domain: "go_language", score: 0, questionCount: 1 },
    { status: "unassessed", domain: "concurrency_runtime_performance" },
    { status: "unassessed", domain: "http_rpc_api" },
    { status: "unassessed", domain: "database_storage" },
    { status: "unassessed", domain: "cache_messaging_distributed" },
    { status: "unassessed", domain: "testing_observability_engineering" },
  ];
}

function reportBase(kind: "complete" | "incomplete") {
  return {
    kind,
    reportId: `report-${kind}`,
    interviewId: "interview-report",
    generatedAt: "2026-08-14T01:00:00.000Z",
    overallExplanation: "本次面试体现了部分基础理解。",
    strengths: ["能够完成面试流程。"],
    weaknesses: ["部分概念需要继续巩固。"],
    priorities: ["优先补齐核心机制。"],
    learningSuggestions: ["结合小型示例复盘。"],
  };
}

function domains() {
  return [
    { status: "assessed", domain: "go_language", score: 88, questionCount: 1 },
    {
      status: "assessed",
      domain: "concurrency_runtime_performance",
      score: 90,
      questionCount: 1,
    },
    { status: "assessed", domain: "http_rpc_api", score: 85, questionCount: 1 },
    { status: "assessed", domain: "database_storage", score: 87, questionCount: 1 },
    {
      status: "assessed",
      domain: "cache_messaging_distributed",
      score: 90,
      questionCount: 1,
    },
    { status: "unassessed", domain: "testing_observability_engineering" },
  ];
}

function scoredQuestion(position: number) {
  return {
    ...questionBase(position),
    outcome: "scored",
    score: 88,
  };
}

function questionBase(position: number) {
  return {
    position,
    displayedQuestion: `第 ${position} 道问题`,
    answerSummary: "回答覆盖了主要机制。",
    matchedKnowledgePoints: ["已说明核心机制。"],
    missingOrIncorrectPoints: ["适用边界仍需补充。"],
    scoreRationale: "根据已确认的评价事实形成结论。",
    improvementSuggestions: ["继续梳理适用边界。"],
  };
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
