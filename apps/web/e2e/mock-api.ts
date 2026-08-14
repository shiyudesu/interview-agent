import type { Page, Route } from "@playwright/test";

export const INTERVIEW_ID = "interview-e2e";

type MockResponse = {
  readonly body?: unknown;
  readonly contentType?: string;
  readonly rawBody?: string;
  readonly status?: number;
};

type MockRequest = {
  readonly body: unknown;
  readonly method: string;
  readonly path: string;
};

type MockHandler = (request: MockRequest) => MockResponse | Promise<MockResponse>;

export type InterviewFlow = "all-zero" | "early-end" | "normal" | "report-retry";

export async function installMockApi(page: Page, handler: MockHandler): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const requestBody = request.postData();
    const response = await handler({
      body: requestBody === null ? null : request.postDataJSON(),
      method: request.method(),
      path: new URL(request.url()).pathname + new URL(request.url()).search,
    });
    await fulfill(route, response);
  });
}

export async function installInterviewFlow(page: Page, flow: InterviewFlow): Promise<void> {
  const finalQuestion = "请说明 Go Context 的取消传播机制。";
  const answer = interviewMessage(
    "message-answer",
    "user",
    "answer",
    "父 Context 会向下传播取消，并保留截止时间。",
  );
  const question = interviewMessage(
    "message-question",
    "interviewer",
    "main_question",
    finalQuestion,
  );
  let detail: unknown;
  let report: unknown;

  if (flow === "early-end") {
    detail = activeInterview({
      availableActions: ["submit_supplement", "continue", "end_early", "abandon"],
      current: 2,
      messages: [question, answer],
      phase: "awaiting_continue",
      version: 8,
    });
    report = incompleteReport();
  } else if (flow === "report-retry") {
    detail = reportPending({
      kind: "complete",
      operation: {
        operationId: "operation-report",
        status: "failed",
        failure: {
          code: "model_failure",
          message: "Report analysis failed",
          retryable: true,
        },
      },
      retryable: true,
      version: 12,
    });
    report = completeReport(88);
  } else {
    detail = activeInterview({
      availableActions:
        flow === "all-zero"
          ? ["mark_unknown", "skip", "end_early", "abandon"]
          : [
              "submit_answer",
              "request_clarification",
              "mark_unknown",
              "skip",
              "end_early",
              "abandon",
            ],
      messages: [question],
      phase: "awaiting_response",
      version: 4,
    });
    report = completeReport(flow === "all-zero" ? 0 : 88);
  }

  await installMockApi(page, ({ method, path }) => {
    if (method === "GET" && path === "/api/v1/account") {
      return json(accountFixture());
    }
    if (method === "GET" && path === `/api/v1/interviews/${INTERVIEW_ID}`) {
      return json(detail);
    }
    if (method === "GET" && path === `/api/v1/interviews/${INTERVIEW_ID}/report`) {
      return json(report);
    }

    if (
      flow === "normal" &&
      method === "POST" &&
      path === `/api/v1/interviews/${INTERVIEW_ID}/answers`
    ) {
      detail = activeInterview({
        availableActions: [],
        messages: [question],
        operation: { operationId: "operation-answer", status: "processing" },
        phase: "processing",
        version: 5,
      });
      return json(processingOperation("operation-answer"), 202);
    }
    if (
      flow === "normal" &&
      method === "GET" &&
      path === "/api/v1/operations/operation-answer/events"
    ) {
      detail = activeInterview({
        availableActions: ["submit_supplement", "continue", "end_early", "abandon"],
        messages: [question, answer],
        phase: "awaiting_continue",
        version: 6,
      });
      return sse("operation-answer");
    }
    if (
      flow === "all-zero" &&
      method === "POST" &&
      path === `/api/v1/interviews/${INTERVIEW_ID}/unknown`
    ) {
      detail = activeInterview({
        availableActions: ["submit_supplement", "continue", "end_early", "abandon"],
        messages: [question],
        phase: "awaiting_continue",
        version: 5,
      });
      return json(succeededOperation("operation-unknown", 5));
    }
    if (
      (flow === "normal" || flow === "all-zero") &&
      method === "POST" &&
      path === `/api/v1/interviews/${INTERVIEW_ID}/continue`
    ) {
      detail = reportPending({
        kind: "complete",
        operation: { operationId: "operation-report", status: "processing" },
        version: 7,
      });
      return json(processingOperation("operation-report"), 202);
    }
    if (
      flow === "early-end" &&
      method === "POST" &&
      path === `/api/v1/interviews/${INTERVIEW_ID}/end-early`
    ) {
      detail = reportPending({
        kind: "incomplete",
        operation: { operationId: "operation-early-report", status: "processing" },
        version: 9,
      });
      return json(processingOperation("operation-early-report"), 202);
    }
    if (
      flow === "report-retry" &&
      method === "POST" &&
      path === `/api/v1/interviews/${INTERVIEW_ID}/retry`
    ) {
      detail = reportPending({
        kind: "complete",
        operation: { operationId: "operation-report", status: "processing" },
        version: 12,
      });
      return json(processingOperation("operation-report"), 202);
    }
    if (
      method === "GET" &&
      (path === "/api/v1/operations/operation-report/events" ||
        path === "/api/v1/operations/operation-early-report/events")
    ) {
      const early = flow === "early-end";
      detail = terminalInterview(early ? "early_ended" : "completed", [question, answer]);
      return sse(early ? "operation-early-report" : "operation-report");
    }

    throw new Error(`Unexpected ${method} ${path} for ${flow}`);
  });
}

export function json(body: unknown, status = 200): MockResponse {
  return { body, status };
}

export function sse(operationId: string): MockResponse {
  return {
    contentType: "text/event-stream",
    rawBody: `id: 1\nevent: succeeded\ndata: ${JSON.stringify({
      operationId,
      sequence: 1,
      occurredAt: "2026-08-14T01:00:00.000Z",
      type: "succeeded",
    })}\n\n`,
  };
}

export function accountFixture() {
  return {
    id: "account-e2e",
    email: "candidate@example.test",
    displayName: "候选人",
    linkedIdentities: [
      {
        provider: "email_otp",
        providerAccountId: "candidate@example.test",
        linkedAt: "2026-08-13T00:00:00.000Z",
      },
    ],
    sessions: [],
    createdAt: "2026-08-13T00:00:00.000Z",
  };
}

export function unauthorized() {
  return {
    error: {
      code: "unauthorized",
      message: "Authentication is required",
    },
  };
}

export function interviewNotFound() {
  return {
    error: {
      code: "not_found",
      message: "Resource was not found.",
      resource: "interview",
    },
  };
}

export function activeInterview(input: {
  readonly availableActions: readonly string[];
  readonly current?: number;
  readonly messages?: readonly ReturnType<typeof interviewMessage>[];
  readonly operation?: {
    readonly failure?: {
      readonly code: "model_failure" | "operation_failed";
      readonly message: string;
      readonly retryable: boolean;
    };
    readonly operationId: string;
    readonly status: "failed" | "pending" | "processing";
  };
  readonly phase: "awaiting_continue" | "awaiting_response" | "processing";
  readonly version: number;
  readonly wording?: string;
}) {
  const wording = input.wording ?? "请说明 Go Context 的取消传播机制。";
  return {
    id: INTERVIEW_ID,
    status: "active",
    version: input.version,
    phase: input.phase,
    progress: { current: input.current ?? 5, total: 5 },
    currentWording: wording,
    messages: input.messages ?? [
      interviewMessage("message-question", "interviewer", "main_question", wording),
    ],
    ...(input.operation === undefined ? {} : { operation: input.operation }),
    availableActions: input.availableActions,
    startedAt: "2026-08-14T00:00:00.000Z",
    lastEffectiveActivityAt: "2026-08-14T00:30:00.000Z",
    expiresAt: "2026-08-15T00:30:00.000Z",
  };
}

export function reportPending(input: {
  readonly kind: "complete" | "incomplete";
  readonly operation: {
    readonly failure?: {
      readonly code: "model_failure";
      readonly message: string;
      readonly retryable: true;
    };
    readonly operationId: string;
    readonly status: "failed" | "processing";
  };
  readonly retryable?: boolean;
  readonly version: number;
}) {
  return {
    id: INTERVIEW_ID,
    status: "report_pending",
    reportKind: input.kind,
    version: input.version,
    progress: { current: 5, total: 5 },
    messages: [],
    operation: input.operation,
    availableActions: input.retryable ? ["retry"] : [],
    startedAt: "2026-08-14T00:00:00.000Z",
    lastEffectiveActivityAt: "2026-08-14T00:30:00.000Z",
    expiresAt: "2026-08-15T00:30:00.000Z",
  };
}

export function terminalInterview(
  status: "completed" | "early_ended",
  messages: readonly ReturnType<typeof interviewMessage>[] = [],
) {
  return {
    id: INTERVIEW_ID,
    status,
    version: 20,
    questionCount: 5,
    reportId: status === "completed" ? "report-complete" : "report-incomplete",
    startedAt: "2026-08-14T00:00:00.000Z",
    endedAt: "2026-08-14T01:00:00.000Z",
    messages,
  };
}

export function interviewMessage(
  id: string,
  role: "interviewer" | "user",
  kind: "answer" | "main_question",
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

export function processingOperation(operationId: string) {
  return {
    operationId,
    status: "processing",
    createdAt: "2026-08-14T00:30:00.000Z",
    updatedAt: "2026-08-14T00:30:00.000Z",
  };
}

export function succeededOperation(operationId: string, interviewVersion: number) {
  return {
    operationId,
    status: "succeeded",
    result: {
      interviewId: INTERVIEW_ID,
      interviewVersion,
      reportId: null,
    },
    createdAt: "2026-08-14T00:30:00.000Z",
    updatedAt: "2026-08-14T00:30:00.000Z",
  };
}

export function completeReport(score: number) {
  return {
    ...reportBase("complete"),
    overallScore: score,
    domains: completeDomains(score),
    questions: Array.from({ length: 5 }, (_, index) =>
      score === 0 ? zeroQuestion(index + 1) : scoredQuestion(index + 1, score),
    ),
  };
}

export function incompleteReport() {
  return {
    ...reportBase("incomplete"),
    domains: [
      { status: "assessed", domain: "go_language", score: 0, questionCount: 1 },
      { status: "unassessed", domain: "concurrency_runtime_performance" },
      { status: "unassessed", domain: "http_rpc_api" },
      { status: "unassessed", domain: "database_storage" },
      { status: "unassessed", domain: "cache_messaging_distributed" },
      { status: "unassessed", domain: "testing_observability_engineering" },
    ],
    questions: [zeroQuestion(1)],
  };
}

export function historyFixture() {
  return {
    items: [
      historyItem("interview-e2e", "completed"),
      historyItem("interview-early", "early_ended"),
      historyItem("interview-abandoned", "abandoned"),
    ],
    pageInfo: { hasMore: false, nextCursor: null },
  };
}

export function deletionAccepted() {
  return {
    status: "deleting",
    requestedAt: "2026-08-14T01:00:00.000Z",
    purgeDeadlineAt: "2026-08-21T01:00:00.000Z",
  };
}

async function fulfill(route: Route, response: MockResponse): Promise<void> {
  await route.fulfill({
    status: response.status ?? 200,
    contentType: response.contentType ?? "application/json",
    body: response.rawBody ?? JSON.stringify(response.body ?? null),
  });
}

function reportBase(kind: "complete" | "incomplete") {
  return {
    kind,
    reportId: `report-${kind}`,
    interviewId: INTERVIEW_ID,
    generatedAt: "2026-08-14T01:00:00.000Z",
    overallExplanation: "本次面试已形成稳定的结构化反馈。",
    strengths: ["能够按流程完成面试。"],
    weaknesses: ["部分概念仍需继续巩固。"],
    priorities: ["优先补齐核心机制。"],
    learningSuggestions: ["结合小型示例进行复盘。"],
  };
}

function completeDomains(score: number) {
  return [
    { status: "assessed", domain: "go_language", score, questionCount: 1 },
    {
      status: "assessed",
      domain: "concurrency_runtime_performance",
      score,
      questionCount: 1,
    },
    { status: "assessed", domain: "http_rpc_api", score, questionCount: 1 },
    { status: "assessed", domain: "database_storage", score, questionCount: 1 },
    {
      status: "assessed",
      domain: "cache_messaging_distributed",
      score,
      questionCount: 1,
    },
    { status: "unassessed", domain: "testing_observability_engineering" },
  ];
}

function scoredQuestion(position: number, score: number) {
  return {
    position,
    displayedQuestion: `第 ${position} 道问题`,
    outcome: "scored",
    score,
    answerSummary: "回答覆盖了主要机制。",
    matchedKnowledgePoints: ["已说明核心机制。"],
    missingOrIncorrectPoints: ["适用边界仍需补充。"],
    scoreRationale: "根据已确认的评价事实形成结论。",
    improvementSuggestions: ["继续梳理适用边界。"],
  };
}

function zeroQuestion(position: number) {
  return {
    position,
    displayedQuestion: `第 ${position} 道问题`,
    outcome: "unknown",
    score: 0,
    zeroScoreReason: "unknown",
    answerSummary: "明确表示暂未掌握。",
    matchedKnowledgePoints: [],
    missingOrIncorrectPoints: ["核心知识尚未获得作答证据。"],
    scoreRationale: "本题没有可用于评分的作答证据。",
    improvementSuggestions: ["先理解核心概念，再结合示例复盘。"],
  };
}

function historyItem(id: string, status: "abandoned" | "completed" | "early_ended") {
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
