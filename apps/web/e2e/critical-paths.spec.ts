import { expect, test } from "./fixtures.js";
import {
  accountFixture,
  activeInterview,
  deletionAccepted,
  historyFixture,
  INTERVIEW_ID,
  installInterviewFlow,
  installMockApi,
  interviewMessage,
  interviewNotFound,
  json,
  terminalInterview,
  unauthorized,
} from "./mock-api.js";

test.describe.configure({ mode: "serial" });

test("uses an email OTP authentication substitute", async ({ page }) => {
  let authenticated = false;
  const requests: { readonly body: unknown; readonly path: string }[] = [];
  await installMockApi(page, ({ body, method, path }) => {
    if (method === "GET" && path === "/api/v1/account") {
      return authenticated ? json(accountFixture()) : json(unauthorized(), 401);
    }
    if (method === "POST" && path === "/api/auth/email-otp/send-verification-otp") {
      requests.push({ body, path });
      return json({ success: true });
    }
    if (method === "POST" && path === "/api/auth/sign-in/email-otp") {
      requests.push({ body, path });
      authenticated = true;
      return json({ success: true });
    }
    if (method === "GET" && path === "/api/v1/interviews/active") {
      return json(interviewNotFound(), 404);
    }
    throw new Error(`Unexpected ${method} ${path}`);
  });

  await page.goto("/sign-in");
  await page.getByRole("textbox", { name: "邮箱地址" }).fill("candidate@example.test");
  await page.getByRole("button", { name: "发送验证码" }).click();
  await page.getByRole("textbox", { name: "显示名称（可选）" }).fill("候选人");
  await page.getByRole("textbox", { name: "6 位验证码" }).fill("123456");
  await page.getByRole("button", { name: "验证并登录" }).click();

  await expect(page).toHaveURL(/\/app$/u);
  await expect(page.getByRole("heading", { name: "创建 Go 后端模拟面试" })).toBeVisible();
  expect(requests).toEqual([
    {
      path: "/api/auth/email-otp/send-verification-otp",
      body: { email: "candidate@example.test", type: "sign-in" },
    },
    {
      path: "/api/auth/sign-in/email-otp",
      body: {
        email: "candidate@example.test",
        name: "候选人",
        otp: "123456",
      },
    },
  ]);
});

test("completes a normal interview through answer, SSE, and report", async ({ page }) => {
  await installInterviewFlow(page, "normal");
  await page.goto(`/interviews/${INTERVIEW_ID}`);

  await expect(page.getByText("第 5 / 5 题")).toBeVisible();
  await page
    .getByRole("textbox", { name: "你的回答" })
    .fill("父 Context 会向下传播取消，并保留截止时间。");
  await page.getByRole("button", { name: "提交回答" }).click();
  await expect(page.getByRole("textbox", { name: "补充回答" })).toBeVisible();
  await page.getByRole("button", { name: "继续下一题" }).click();
  await page.getByRole("link", { name: "查看完整报告" }).click();

  await expect(page.getByRole("heading", { name: "完整面试报告" })).toBeVisible();
  await expect(page.getByText("总分 / 100")).toBeVisible();
  await expect(page.getByText("88", { exact: true }).first()).toBeVisible();
});

test("stores an all-zero normal completion as a complete report", async ({ page }) => {
  await installInterviewFlow(page, "all-zero");
  await page.goto(`/interviews/${INTERVIEW_ID}`);

  await page.getByRole("button", { name: "我不知道" }).click();
  await expect(page.getByRole("button", { name: "继续下一题" })).toBeEnabled();
  await page.getByRole("button", { name: "继续下一题" }).click();
  await page.getByRole("link", { name: "查看完整报告" }).click();

  await expect(page.getByRole("heading", { name: "完整面试报告" })).toBeVisible();
  await expect(page.getByText("总分 / 100")).toBeVisible();
  await expect(page.getByText("0", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("未掌握").first()).toBeVisible();
});

test("ends early and renders an incomplete report without a score", async ({ page }) => {
  await installInterviewFlow(page, "early-end");
  await page.goto(`/interviews/${INTERVIEW_ID}`);

  await page.getByRole("button", { name: "提前结束并生成报告" }).click();
  await page.getByRole("link", { name: "查看不完整报告" }).click();

  await expect(page.getByRole("heading", { name: "不完整面试报告" })).toBeVisible();
  await expect(page.getByText("不提供总分")).toBeVisible();
  await expect(page.getByText("总分 / 100")).toHaveCount(0);
});

test("resumes an active interview across reloads", async ({ page }) => {
  const active = activeInterview({
    availableActions: [
      "submit_answer",
      "request_clarification",
      "mark_unknown",
      "skip",
      "end_early",
      "abandon",
    ],
    current: 2,
    phase: "awaiting_response",
    version: 3,
    wording: "请说明 Go channel 的关闭语义。",
  });
  await installMockApi(page, ({ method, path }) => {
    if (method === "GET" && path === "/api/v1/account") {
      return json(accountFixture());
    }
    if (method === "GET" && path === "/api/v1/interviews/active") {
      return json(active);
    }
    if (method === "GET" && path === `/api/v1/interviews/${INTERVIEW_ID}`) {
      return json(active);
    }
    throw new Error(`Unexpected ${method} ${path}`);
  });

  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "你已有一场未结束的面试" })).toBeVisible();
  await page.getByRole("link", { name: "恢复当前面试" }).click();
  await expect(page.getByRole("heading", { name: "请说明 Go channel 的关闭语义。" })).toBeVisible();
  await page.reload();
  await expect(page.getByText("第 2 / 5 题")).toBeVisible();
});

test("retries only report generation and reaches the immutable report", async ({ page }) => {
  await installInterviewFlow(page, "report-retry");
  await page.goto(`/interviews/${INTERVIEW_ID}`);

  await expect(page.getByText("Report analysis failed")).toBeVisible();
  await page.getByRole("button", { name: "重试报告生成" }).click();
  await page.getByRole("link", { name: "查看完整报告" }).click();

  await expect(page.getByRole("heading", { name: "完整面试报告" })).toBeVisible();
  await expect(page.getByText("本报告生成后保持只读")).toBeVisible();
});

test("shows state-aware history and opens the immutable transcript", async ({ page }) => {
  const terminal = terminalInterview("completed", [
    interviewMessage("history-question", "interviewer", "main_question", "历史问题。"),
    interviewMessage("history-answer", "user", "answer", "历史回答。"),
  ]);
  await installMockApi(page, ({ method, path }) => {
    if (method === "GET" && path === "/api/v1/account") {
      return json(accountFixture());
    }
    if (method === "GET" && path === "/api/v1/interviews?limit=20") {
      return json(historyFixture());
    }
    if (method === "GET" && path === `/api/v1/interviews/${INTERVIEW_ID}`) {
      return json(terminal);
    }
    throw new Error(`Unexpected ${method} ${path}`);
  });

  await page.goto("/history");
  await expect(page.getByText("已完成")).toBeVisible();
  await expect(page.getByText("提前结束")).toBeVisible();
  await expect(page.getByText("已放弃")).toBeVisible();
  await expect(page.getByText("88", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "查看面试记录" }).first().click();

  await expect(page.getByText("历史回答。")).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
});

test("confirms interview deletion and removes the deleted resource", async ({ page }) => {
  let deleted = false;
  const terminal = terminalInterview("completed", [
    interviewMessage("delete-question", "interviewer", "main_question", "待删除问题。"),
  ]);
  await installMockApi(page, ({ method, path }) => {
    if (method === "GET" && path === "/api/v1/account") {
      return json(accountFixture());
    }
    if (method === "GET" && path === `/api/v1/interviews/${INTERVIEW_ID}`) {
      return deleted ? json(interviewNotFound(), 404) : json(terminal);
    }
    if (method === "DELETE" && path === `/api/v1/interviews/${INTERVIEW_ID}`) {
      deleted = true;
      return json(deletionAccepted(), 202);
    }
    if (method === "GET" && path === "/api/v1/interviews?limit=20") {
      return json({
        items: [],
        pageInfo: { hasMore: false, nextCursor: null },
      });
    }
    throw new Error(`Unexpected ${method} ${path}`);
  });

  await page.goto(`/interviews/${INTERVIEW_ID}`);
  await page.getByRole("button", { name: "删除此面试" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("删除这场面试？");
  await page.getByRole("button", { name: "确认删除面试" }).click();

  await expect(page).toHaveURL(/\/history$/u);
  await expect(page.getByText("暂无历史面试", { exact: true })).toBeVisible();
  await expect(page.getByText("待删除问题。")).toHaveCount(0);
  expect(deleted).toBe(true);
});
