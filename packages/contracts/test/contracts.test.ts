import { validateImmutableReportSnapshot } from "@interview-agent/domain";
import { Check, Errors } from "typebox/value";
import { describe, expect, it } from "vitest";

import {
  AbandonInterviewRequestSchema,
  ActiveInterviewProgressSchema,
  ActiveInterviewResponseSchema,
  CompleteReportResponseSchema,
  ContinueInterviewRequestSchema,
  CreateInterviewRequestSchema,
  EndInterviewEarlyRequestSchema,
  ErrorEnvelopeSchema,
  IncompleteReportResponseSchema,
  InternalCompleteReportSnapshotSchema,
  InternalIncompleteReportSnapshotSchema,
  InterviewDetailResponseSchema,
  MarkQuestionUnknownRequestSchema,
  OperationEventSchema,
  OperationStatusResponseSchema,
  PublicReportQuestionFeedbackSchema,
  QuestionBankImportSchema,
  QuestionBankQuestionSchema,
  QuestionBankSourceSchema,
  ReportPendingInterviewResponseSchema,
  RequestClarificationRequestSchema,
  RetryOperationRequestSchema,
  ServerEnvironmentSchema,
  SkipQuestionRequestSchema,
  StructuredAnswerEvaluationSchema,
  SubmitAnswerRequestSchema,
  SubmitSupplementRequestSchema,
  validateInternalReportSnapshot,
  validateQuestionBankQuestion,
  validateQuestionBankSource,
  validateReportResponse,
} from "../src/index.js";

const now = "2026-08-09T12:00:00.000Z";

const modelMetadata = {
  provider: "faux",
  modelId: "faux-v1",
  promptVersion: "answer-evaluation-v1",
  schemaVersion: "1.0",
  questionVersion: 1,
  purpose: "answer_evaluation",
  latencyMs: 42,
  tokens: {
    inputTokens: 100,
    outputTokens: 50,
  },
};

const questionBankQuestion = {
  id: "go.context.001",
  contentVersion: 1,
  domain: "go_language",
  difficulty: "medium",
  questionType: "conceptual",
  sourceWording: "请解释 context.Context 的用途。",
  rubric: [
    {
      id: "go.context.001.cancel",
      description: "说明取消信号传播",
      weight: 50,
    },
    {
      id: "go.context.001.deadline",
      description: "说明截止时间传播",
      weight: 50,
    },
  ],
  followUpGoals: [
    {
      id: "go.context.001.clarification",
      kind: "clarification",
      goal: "澄清回答中提到的取消传播范围",
    },
    {
      id: "go.context.001.follow-up",
      kind: "depth",
      goal: "解释请求范围值的使用边界",
    },
  ],
  knowledgeExplanation: "Context 在调用链上传递取消、截止时间和请求范围值。",
  active: true,
  reviewed: true,
  reviewMetadata: {
    reviewedBy: "reviewer-1",
    reviewedAt: now,
    simplifiedChineseVerified: true,
    technicalTermsVerified: true,
  },
};

const incompleteDomains = [
  {
    status: "assessed",
    domain: "go_language",
    score: 80,
    questionCount: 1,
  },
  {
    status: "unassessed",
    domain: "concurrency_runtime_performance",
  },
  {
    status: "unassessed",
    domain: "http_rpc_api",
  },
  {
    status: "unassessed",
    domain: "database_storage",
  },
  {
    status: "unassessed",
    domain: "cache_messaging_distributed",
  },
  {
    status: "unassessed",
    domain: "testing_observability_engineering",
  },
] as const;

const domains = incompleteDomains.map((result, index) =>
  index < 5
    ? {
        status: "assessed" as const,
        domain: result.domain,
        score: 80,
        questionCount: 1,
      }
    : result,
);

const allAssessedDomains = incompleteDomains.map((result) => ({
  status: "assessed" as const,
  domain: result.domain,
  score: 80,
  questionCount: 1,
}));

const internalReportQuestion = {
  questionId: "go.context.001",
  questionVersion: 1,
  domain: "go_language",
  position: 1,
  displayedQuestion: "请解释 context.Context 的用途。",
  answerSummary: "回答提到了取消信号和截止时间。",
  score: 80,
  outcome: "scored",
  matchedKnowledgePoints: [
    {
      rubricItemId: "go.context.001.cancel",
      summary: "能够说明取消信号沿调用链传播",
      awardedPoints: 80,
      evidence: [
        {
          source: "answer_material",
          answerMaterialId: "answer-1",
        },
      ],
    },
  ],
  missingOrIncorrectPoints: [
    {
      rubricItemId: "go.context.001.cancel",
      summary: "未准确说明 Value 的请求范围限制",
      evidence: [
        {
          source: "question_snapshot",
          questionId: "go.context.001",
        },
      ],
    },
  ],
  scoreRationale: "答案覆盖了主要用途，但遗漏了 Value 的边界。",
  improvementSuggestions: ["复习 Context Value 只应承载请求范围数据的约束。"],
  evidence: [
    {
      source: "answer_material",
      answerMaterialId: "answer-1",
    },
    {
      source: "question_snapshot",
      questionId: "go.context.001",
    },
  ],
};

const publicReportQuestion = {
  position: 1,
  displayedQuestion: "请解释 context.Context 的用途。",
  answerSummary: "回答提到了取消信号和截止时间。",
  score: 80,
  outcome: "scored",
  matchedKnowledgePoints: ["能够说明取消信号沿调用链传播"],
  missingOrIncorrectPoints: ["未准确说明 Value 的请求范围限制"],
  scoreRationale: "答案覆盖了主要用途，但遗漏了 Value 的边界。",
  improvementSuggestions: ["复习 Context Value 只应承载请求范围数据的约束。"],
};

const internalReportQuestions = Array.from({ length: 5 }, (_, index) => {
  const questionId = `go.question.${index + 1}`;
  return {
    ...internalReportQuestion,
    questionId,
    domain: incompleteDomains[index]?.domain,
    position: index + 1,
    missingOrIncorrectPoints: internalReportQuestion.missingOrIncorrectPoints.map((point) => ({
      ...point,
      evidence: [{ source: "question_snapshot" as const, questionId }],
    })),
    evidence: [
      ...internalReportQuestion.evidence.slice(0, 1),
      { source: "question_snapshot" as const, questionId },
    ],
  };
});

const publicReportQuestions = Array.from({ length: 5 }, (_, index) => ({
  ...publicReportQuestion,
  position: index + 1,
}));

const reportDisplay = {
  reportId: "report-1",
  interviewId: "interview-1",
  generatedAt: now,
  domains,
  overallExplanation: "基础知识较扎实。",
  strengths: ["能够解释取消传播。"],
  weaknesses: ["对请求范围值的边界理解不完整。"],
  priorities: ["优先补充 Context 使用约束。"],
  learningSuggestions: ["阅读 context 包文档并分析实际请求链路。"],
};

const internalReport = {
  ...reportDisplay,
  accountId: "account-1",
  schemaVersion: "1.0",
  questions: internalReportQuestions,
  modelMetadata,
  questionVersions: internalReportQuestions.map((question) => ({
    questionId: question.questionId,
    questionVersion: 1,
  })),
};

const publicReport = {
  ...reportDisplay,
  questions: publicReportQuestions,
};

const activeInterview = {
  id: "interview-1",
  status: "active",
  phase: "awaiting_response",
  version: 3,
  progress: {
    current: 2,
    total: 5,
  },
  currentWording: "请解释 Go interface 的动态类型和值。",
  messages: [
    {
      id: "message-1",
      role: "interviewer",
      kind: "main_question",
      text: "请解释 Go interface 的动态类型和值。",
      createdAt: now,
    },
  ],
  availableActions: ["submit_answer", "request_clarification", "mark_unknown", "skip"],
  startedAt: now,
  lastEffectiveActivityAt: now,
  expiresAt: "2026-08-10T12:00:00.000Z",
};

describe("API command and error schemas", () => {
  it("accepts only supported interview question counts", () => {
    expect(Check(CreateInterviewRequestSchema, { questionCount: 5, expectedVersion: 0 })).toBe(
      true,
    );
    expect(Check(CreateInterviewRequestSchema, { questionCount: 7, expectedVersion: 0 })).toBe(
      false,
    );
  });

  it("validates the stable version-conflict error envelope", () => {
    const envelope = {
      error: {
        code: "version_conflict",
        message: "Interview state changed",
        interviewId: "interview-1",
        currentVersion: 8,
      },
    };

    expect(Check(ErrorEnvelopeSchema, envelope)).toBe(true);
    expect(
      Check(ErrorEnvelopeSchema, {
        ...envelope,
        error: { ...envelope.error, expectedVersion: 7 },
      }),
    ).toBe(false);
  });

  it.each([
    [SubmitAnswerRequestSchema, { text: "answer" }],
    [SubmitSupplementRequestSchema, { text: "supplement" }],
    [RequestClarificationRequestSchema, {}],
    [MarkQuestionUnknownRequestSchema, {}],
    [SkipQuestionRequestSchema, {}],
    [ContinueInterviewRequestSchema, {}],
    [EndInterviewEarlyRequestSchema, {}],
    [AbandonInterviewRequestSchema, {}],
    [RetryOperationRequestSchema, { operationId: "operation-1" }],
  ])("requires expectedVersion on every interview mutation", (schema, body) => {
    expect(Check(schema, body)).toBe(false);
    expect(Check(schema, { ...body, expectedVersion: 2 })).toBe(true);
  });
});

describe("discriminated interview lifecycle responses", () => {
  it.each([
    [{ current: 1, total: 5 }, true],
    [{ current: 5, total: 5 }, true],
    [{ current: 1, total: 10 }, true],
    [{ current: 10, total: 10 }, true],
    [{ current: 1, total: 15 }, true],
    [{ current: 15, total: 15 }, true],
    [{ current: 0, total: 5 }, false],
    [{ current: 6, total: 5 }, false],
    [{ current: 99, total: 5 }, false],
    [{ current: 11, total: 10 }, false],
    [{ current: 16, total: 15 }, false],
  ])("constrains active progress to the selected total: %o", (progress, expected) => {
    expect(Check(ActiveInterviewProgressSchema, progress)).toBe(expected);
  });

  it("accepts an active response without terminal fields", () => {
    expect(Check(ActiveInterviewResponseSchema, activeInterview)).toBe(true);
    expect(Check(ActiveInterviewResponseSchema, { ...activeInterview, endedAt: now })).toBe(false);
  });

  it("couples processing with a current Operation and no answer actions", () => {
    const processing = {
      ...activeInterview,
      phase: "processing",
      operation: {
        operationId: "operation-1",
        status: "processing",
      },
      availableActions: [],
    };
    expect(Check(ActiveInterviewResponseSchema, processing)).toBe(true);
    expect(
      Check(ActiveInterviewResponseSchema, {
        ...processing,
        operation: { operationId: "operation-1", status: "pending" },
      }),
    ).toBe(false);
    expect(
      Check(ActiveInterviewResponseSchema, {
        ...processing,
        availableActions: ["submit_answer"],
      }),
    ).toBe(false);
    expect(Check(ActiveInterviewResponseSchema, { ...processing, operation: undefined })).toBe(
      false,
    );
  });

  it("requires retryable active failures to expose the failed Operation and retry action", () => {
    const failed = {
      ...activeInterview,
      operation: {
        operationId: "operation-1",
        status: "failed",
        failure: {
          code: "model_failure",
          message: "Provider unavailable",
          retryable: true,
        },
      },
      availableActions: ["submit_answer", "retry"],
    };
    expect(Check(ActiveInterviewResponseSchema, failed)).toBe(true);
    expect(
      Check(ActiveInterviewResponseSchema, { ...failed, availableActions: ["submit_answer"] }),
    ).toBe(false);
  });

  it("exposes report kind and Operation state without answer actions while report-pending", () => {
    const reportPending = {
      id: "interview-1",
      status: "report_pending",
      reportKind: "complete",
      version: 8,
      progress: { current: 5, total: 5 },
      messages: activeInterview.messages,
      startedAt: now,
      lastEffectiveActivityAt: now,
      expiresAt: "2026-08-10T12:00:00.000Z",
      operation: {
        operationId: "operation-report-1",
        status: "failed",
        failure: {
          code: "model_failure",
          message: "Provider unavailable",
          retryable: true,
        },
      },
      availableActions: ["retry"],
    };
    expect(Check(ReportPendingInterviewResponseSchema, reportPending)).toBe(true);
    expect(
      Check(ReportPendingInterviewResponseSchema, {
        ...reportPending,
        availableActions: ["retry", "submit_answer"],
      }),
    ).toBe(false);
    expect(
      Check(ReportPendingInterviewResponseSchema, {
        ...reportPending,
        operation: {
          ...reportPending.operation,
          failure: { ...reportPending.operation.failure, retryable: false },
        },
        availableActions: [],
      }),
    ).toBe(false);
  });

  it("requires reports for completed and early-ended, and forbids them for abandoned", () => {
    const terminal = {
      id: "interview-1",
      version: 9,
      questionCount: 5,
      startedAt: now,
      endedAt: now,
      messages: activeInterview.messages,
    };
    expect(
      Check(InterviewDetailResponseSchema, {
        ...terminal,
        status: "completed",
        reportId: "report-1",
      }),
    ).toBe(true);
    expect(Check(InterviewDetailResponseSchema, { ...terminal, status: "completed" })).toBe(false);
    expect(
      Check(InterviewDetailResponseSchema, {
        ...terminal,
        status: "early_ended",
        reportId: "report-1",
      }),
    ).toBe(true);
    expect(Check(InterviewDetailResponseSchema, { ...terminal, status: "abandoned" })).toBe(true);
    expect(
      Check(InterviewDetailResponseSchema, {
        ...terminal,
        status: "abandoned",
        reportId: "report-1",
      }),
    ).toBe(false);
  });
});

describe("Operation schemas", () => {
  const failure = {
    code: "model_failure",
    message: "Model request failed",
    retryable: false,
  };

  it.each([
    {
      operationId: "operation-1",
      sequence: 0,
      occurredAt: now,
      type: "text_delta",
      text: "你好",
    },
    {
      operationId: "operation-1",
      sequence: 1,
      occurredAt: now,
      type: "succeeded",
    },
    {
      operationId: "operation-1",
      sequence: 1,
      occurredAt: now,
      type: "failed",
      failure,
    },
  ])("accepts the $type event variant", (event) => {
    expect(Check(OperationEventSchema, event)).toBe(true);
  });

  it("uses the same retryable failure detail in SSE, API errors, and canonical status", () => {
    expect(
      Check(ErrorEnvelopeSchema, {
        error: {
          code: "operation_failure",
          operationId: "operation-1",
          failure: { ...failure, retryable: true },
        },
      }),
    ).toBe(true);
    expect(
      Check(OperationStatusResponseSchema, {
        operationId: "operation-1",
        status: "failed",
        createdAt: now,
        updatedAt: now,
        failure,
      }),
    ).toBe(true);
  });

  it("keeps presentation events separate from durable results", () => {
    expect(
      Check(OperationEventSchema, {
        operationId: "operation-1",
        sequence: 1,
        occurredAt: now,
        type: "succeeded",
        result: {
          interviewId: "interview-1",
          interviewVersion: 2,
          reportId: null,
        },
      }),
    ).toBe(false);

    expect(
      Check(OperationStatusResponseSchema, {
        operationId: "operation-1",
        status: "succeeded",
        createdAt: now,
        updatedAt: now,
        result: {
          interviewId: "interview-1",
          interviewVersion: 2,
          reportId: null,
        },
      }),
    ).toBe(true);
  });
});

describe("question-bank schemas", () => {
  it("accepts reviewed non-coding questions with a 100-point Rubric", () => {
    expect(Check(QuestionBankQuestionSchema, questionBankQuestion)).toBe(true);
    expect(validateQuestionBankQuestion(questionBankQuestion)).toEqual([]);
  });

  it("rejects coding-task representations and unknown fields", () => {
    expect(
      Check(QuestionBankQuestionSchema, {
        ...questionBankQuestion,
        codingTask: {
          starterCode: "package main",
        },
      }),
    ).toBe(false);
    expect(
      Check(QuestionBankQuestionSchema, {
        ...questionBankQuestion,
        questionType: "coding",
      }),
    ).toBe(false);
    expect(
      validateQuestionBankQuestion({
        ...questionBankQuestion,
        questionType: "scenario",
        sourceWording: "请阅读以下代码并说明输出结果。",
      }),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "prohibited_coding_task" })]),
    );
    expect(
      validateQuestionBankQuestion({
        ...questionBankQuestion,
        sourceWording: "请阅读以下内容并回答：\n```go\nfunc main() {}\n```",
      }),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "prohibited_coding_task" })]),
    );
  });

  it.each([
    "请实现一个反转链表的算法。",
    "请编写一个处理 HTTP 请求的函数。",
    "请写出生产者消费者模型的伪代码。",
    "请提交一个可执行程序解决该问题。",
    "请完成这道在线评测任务。",
    "请用 Go 实现一个并发安全的缓存。",
    "请用 Go 写一个并发安全的缓存函数。",
    "请用代码实现一个并发安全的缓存。",
    "请完成一道关于并发控制的编程题。",
    "请给出一个 Go 函数来解决这个问题。",
    "请实现一个并发安全的 LRU 缓存。",
    "用 Go 实现一个并发安全的缓存。",
    "请解释在线评测系统的隔离机制；请用 Go 实现一个并发安全的缓存。",
    "请先说明缓存淘汰策略，然后提供完整源代码。",
    "请解释缓存一致性，然后实现一个并发安全的缓存。",
    "请解释缓存一致性，并且创建一个并发安全的缓存。",
    "请分析任务积压的原因，同时开发一个并发安全的队列。",
    "请说明限流方案，此外编码一个并发安全的服务组件。",
    "请讨论锁的选择，接着实现一个并发安全的数据结构。",
    "在回答的最后，请提供完整源代码。",
    "候选人需要创建一个可执行脚本来验证结果。",
    "请实现一个并发安全的队列。",
    "请实现一个并发安全的服务。",
    "请实现一个并发安全的组件。",
    "请实现一个并发安全的数据结构。",
    "请用 Go 实现二叉树遍历。",
    "请实现一个数据库连接池。",
    "请基于 Go 编写一个 HTTP 服务器。",
    "请基于 Go 写一个 HTTP 服务器。",
    "请你实现一个并发安全的缓存。",
    "请构建一个并发安全的缓存服务。",
    "请根据以下代码判断输出结果。",
    "请阅读下面的代码并说明输出结果。",
    "请查看下面的代码并指出其中的问题。",
    "能否写一个并发安全的缓存函数？",
    "可以写一个并发安全的缓存函数吗？",
    "你能写一个函数吗？",
    "能不能构建一个缓存服务？",
    "可否写一段代码？",
    "是否能写一个 Java 方法来反转字符串？",
    "请写一个 SQL 查询统计用户数量。",
    "可以构建一个 REST API endpoint 吗？",
    "请写 SQL 统计用户数量。",
    "请构建一个 REST API。",
    "请写入一段代码到文件。",
    "请写操作系统内核代码。",
    "请修复这个函数中的竞态条件。",
    "请修改以下 SQL 查询以正确统计用户数量。",
    "请阅读这个函数并指出其中的错误。",
    "请阅读以下 SQL，说明该查询为什么会返回重复行。",
    "请搭建一个 REST API 服务并交付。",
    "请展示一段完整的 Go 源代码。",
    "请优化以下 SQL 查询以减少全表扫描。",
    "请实现一个数据库连接池并说明设计思路。",
    "请提供完整源代码并解释设计思路。",
    "请说明以下函数 `func f() int { return 1 }` 的输出结果。",
    "函数 `func f() int { return 1 }` 的输出是什么？",
    "请说明以下方法 `f()` 的输出结果。",
    "以下 SQL 查询应该如何优化？",
    "请优化该查询以减少全表扫描。",
    "请交付一个可运行的 Docker 镜像。",
    "请写一段 Bash 命令删除临时文件。",
    "请解释下面的函数为什么会发生死锁。",
    "请使用伪代码描述 LRU 缓存的淘汰流程。",
    "请交付一个可运行的 Go 服务。",
    "请提交答案，系统会自动评测。",
    "请审查下面的函数并找出竞态条件。",
    "请生成一段 Go 代码演示缓存淘汰。",
    "请以伪代码形式回答缓存淘汰流程。",
    "请输出一个可运行的 Go 服务。",
    "你的答案会被自动评测。",
    "请解释下面的函数为什么死锁。另请说明 errors.Is 的用途。",
    "请完成一个 Go 函数并解释设计思路。",
    "你的任务是实现一个并发安全的缓存。",
    "这是一道在线编程题：给定一个整数 n，输出 n 的平方。",
    "请阅读 `x := 1; fmt.Println(x)` 并说明输出结果。",
    "请开发一个缓存并谈谈设计思路。",
    "请解释缓存一致性并实现一个数据库连接池。",
    "请说明连接复用的优点，并编写数据库连接池。",
    "请分析请求延迟，然后创建负载生成器。",
    "请讨论事务边界并提供数据库访问层。",
  ])("rejects Chinese coding instruction wording: %s", (sourceWording) => {
    expect(
      validateQuestionBankQuestion({
        ...questionBankQuestion,
        sourceWording,
      }),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "prohibited_coding_task" })]),
    );
  });

  it("scans follow-up goals but not internal knowledge explanations for coding markers", () => {
    expect(
      validateQuestionBankQuestion({
        ...questionBankQuestion,
        followUpGoals: [
          {
            ...questionBankQuestion.followUpGoals[0],
            goal: "请用 Go 编写一个函数验证你的回答",
          },
          questionBankQuestion.followUpGoals[1],
        ],
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/followUpGoals/0/goal",
          code: "prohibited_coding_task",
        }),
      ]),
    );

    expect(
      validateQuestionBankQuestion({
        ...questionBankQuestion,
        knowledgeExplanation: "内部说明可包含示例：\n```go\nfunc main() {}\n```",
      }).filter((issue) => issue.code === "prohibited_coding_task"),
    ).toEqual([]);
  });

  it.each([
    "请解释在线评测系统通常如何隔离不可信进程。",
    "请说明 Go 程序运行时 GC 的触发条件。",
    "请解释 HTTP 处理程序的执行流程。",
    "请解释 Go 调度器的实现如何减少函数调用开销。",
    "请说明标准库如何实现 HTTP 处理程序的超时控制。",
    "实现 HTTP 处理程序时需要考虑哪些超时设置？",
    "请给出数据库索引失效的常见原因。",
    "请解释如何实现缓存一致性。",
    "请说明 Go map 是如何实现的。",
    "请说明写操作对存储引擎的影响。",
    "请解释构建过程中的依赖解析机制。",
    "请解释 Go 写屏障的作用和工作原理。",
    "请说明写入操作对存储引擎的影响。",
    "请解释构建器模式的适用场景和主要取舍。",
    "请分析 Go 写屏障如何影响函数调用开销。",
    "请解释构建器模式在程序设计中的取舍。",
    "能否解释为什么系统需要写代码而不是使用配置？",
    "请提供一种排查数据库慢查询的思路。",
    "请写出数据库索引失效的常见原因。",
    "请提供一种实现分布式锁的思路。",
    "请给出函数调用开销过高的常见原因。",
    "请概述实现缓存一致性的步骤。",
    "请阐述实现分布式锁的过程。",
    "请说明该函数 `errors.Is` 的用途。",
    "请说明 os.Create 的错误处理方式。",
    "构建并运行 Go 服务时需要考虑哪些安全问题？",
    "请列举实现分布式锁时的常见风险。",
    "实现缓存一致性有何风险？",
    "请说明函数错误处理与 errors.Is 的关系。",
    "请说明 HTTP 处理函数返回值的设计取舍。",
    "请讨论函数输出缓冲对日志性能的影响。",
    "请给出 SQL 查询优化的常见策略。",
  ])("allows conceptual discussion of coding infrastructure: %s", (sourceWording) => {
    expect(
      validateQuestionBankQuestion({
        ...questionBankQuestion,
        sourceWording,
      }),
    ).toEqual([]);
  });

  it("requires meaningful Simplified Chinese while allowing English technical terms", () => {
    for (const sourceWording of [
      "请 explain Go GC behavior.",
      "请解释 Go のガベージコレクション机制。",
      "请解释 Go의 가비지 컬렉션机制。",
      "請解释 Go GC 的作用和主要阶段。",
    ]) {
      expect(
        validateQuestionBankQuestion({
          ...questionBankQuestion,
          sourceWording,
        }),
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "source_wording_language" })]),
      );
    }

    for (const sourceWording of [
      "请说明 Go 的 GC 如何降低暂停时间。",
      "请解释 HTTP keep-alive 对连接复用的影响。",
      "请解释 Go scheduler 如何调度 goroutine 并减少线程切换。",
      "请说明 Go 是著名的并发编程语言之一。",
      "请说明 copy-on-write 的适用场景。",
      "请比较 read/write lock 与 mutex 的取舍。",
      "请说明 SQL EXPLAIN 的主要用途。",
      "请详细比较 optimistic concurrency control 与 two-phase locking 在高并发事务冲突处理、回滚成本和吞吐量方面的核心取舍。",
      "请说明 happens-before 关系如何约束内存可见性。",
      "请说明 happens before 关系如何约束内存可见性。",
    ]) {
      expect(
        validateQuestionBankQuestion({
          ...questionBankQuestion,
          sourceWording,
        }),
      ).toEqual([]);
    }
  });

  it("requires Simplified Chinese across Rubrics, follow-up goals, and knowledge explanations", () => {
    const issues = validateQuestionBankQuestion({
      ...questionBankQuestion,
      rubric: questionBankQuestion.rubric.map((item, index) =>
        index === 0 ? { ...item, description: "說明取消訊號如何傳播" } : item,
      ),
      followUpGoals: questionBankQuestion.followUpGoals.map((goal, index) =>
        index === 0 ? { ...goal, goal: "請補充取消訊號的傳播範圍" } : goal,
      ),
      knowledgeExplanation: "這段說明使用繁體中文描述技術概念。",
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/rubric/0/description", code: "source_wording_language" }),
        expect.objectContaining({ path: "/followUpGoals/0/goal", code: "source_wording_language" }),
        expect.objectContaining({ path: "/knowledgeExplanation", code: "source_wording_language" }),
      ]),
    );
  });

  it("rejects ordinary English prose while allowing English technical terms", () => {
    for (const [path, value] of [
      ["/sourceWording", { sourceWording: "请 explain Go GC 的作用和主要阶段。" }],
      [
        "/sourceWording",
        {
          sourceWording:
            "请判断下面的说法是否正确：Go GC reclaims unreachable objects automatically.",
        },
      ],
      [
        "/sourceWording",
        {
          sourceWording:
            "请详细说明垃圾回收的核心原理、触发条件、扫描流程以及暂停影响，Go GC reclaims unreachable objects automatically.",
        },
      ],
      [
        "/sourceWording",
        {
          sourceWording:
            "请判断 `This function returns true when the input is valid` 这句话是否正确。",
        },
      ],
      [
        "/sourceWording",
        {
          sourceWording: "请判断 `Garbage collector sweeps objects` 这句话是否正确。",
        },
      ],
      [
        "/rubric/0/description",
        {
          rubric: questionBankQuestion.rubric.map((item, index) =>
            index === 0 ? { ...item, description: "请 explain GC 的核心机制" } : item,
          ),
        },
      ],
      [
        "/followUpGoals/0/goal",
        {
          followUpGoals: questionBankQuestion.followUpGoals.map((goal, index) =>
            index === 0 ? { ...goal, goal: "请 describe goroutine 的退出条件" } : goal,
          ),
        },
      ],
      [
        "/knowledgeExplanation",
        { knowledgeExplanation: "请 explain compare-and-swap 与 mutex 的主要区别。" },
      ],
    ] as const) {
      expect(validateQuestionBankQuestion({ ...questionBankQuestion, ...value })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path, code: "source_wording_language" }),
        ]),
      );
    }
  });

  it("requires auditable review metadata for active questions", () => {
    expect(
      validateQuestionBankQuestion({
        ...questionBankQuestion,
        reviewed: false,
        reviewMetadata: null,
      }),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: "active_not_reviewed" })]));
    expect(
      validateQuestionBankQuestion({
        ...questionBankQuestion,
        reviewMetadata: null,
      }),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "invalid_review_metadata" })]),
    );
  });

  it("reports Rubric totals that JSON Schema cannot express", () => {
    const invalidQuestion = {
      ...questionBankQuestion,
      rubric: questionBankQuestion.rubric.map((item) => ({ ...item, weight: 40 })),
    };

    expect(Check(QuestionBankQuestionSchema, invalidQuestion)).toBe(true);
    expect(validateQuestionBankQuestion(invalidQuestion)).toEqual([
      {
        path: "/rubric",
        code: "rubric_total",
        message: "Rubric weights must total 100, received 80",
      },
    ]);
  });

  it("requires non-empty follow-up goals including a clarification goal", () => {
    const emptyGoals = {
      ...questionBankQuestion,
      followUpGoals: [],
    };
    expect(Check(QuestionBankQuestionSchema, emptyGoals)).toBe(false);
    expect(validateQuestionBankQuestion(emptyGoals)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "schema" })]),
    );

    const depthOnly = {
      ...questionBankQuestion,
      followUpGoals: questionBankQuestion.followUpGoals.filter((goal) => goal.kind === "depth"),
    };
    expect(Check(QuestionBankQuestionSchema, depthOnly)).toBe(true);
    expect(validateQuestionBankQuestion(depthOnly)).toEqual([
      expect.objectContaining({ code: "missing_clarification_goal" }),
    ]);
  });

  it("rejects duplicate nested Rubric and follow-up goal IDs", () => {
    const duplicateIds = {
      ...questionBankQuestion,
      rubric: [
        questionBankQuestion.rubric[0],
        {
          ...questionBankQuestion.rubric[1],
          id: questionBankQuestion.rubric[0]?.id,
        },
      ],
      followUpGoals: [
        ...questionBankQuestion.followUpGoals,
        {
          id: questionBankQuestion.followUpGoals[0]?.id,
          kind: "depth",
          goal: "使用不同内容但复用同一目标 ID",
        },
      ],
    };

    expect(Check(QuestionBankQuestionSchema, duplicateIds)).toBe(true);
    expect(validateQuestionBankQuestion(duplicateIds)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "duplicate_rubric_item_id" }),
        expect.objectContaining({ code: "duplicate_follow_up_goal_id" }),
      ]),
    );
  });

  it("validates strict versioned domain files and duplicate versions", () => {
    const source = {
      schemaVersion: "1.0",
      domain: "go_language",
      questions: [questionBankQuestion],
    };
    expect(Check(QuestionBankSourceSchema, source)).toBe(true);
    expect(validateQuestionBankSource(source)).toEqual([]);
    expect(
      validateQuestionBankSource({
        ...source,
        questions: [questionBankQuestion, questionBankQuestion],
      }),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "duplicate_question_version" })]),
    );
    expect(Check(QuestionBankSourceSchema, { ...source, schemaVersion: "2.0" })).toBe(false);
    expect(Check(QuestionBankSourceSchema, { ...source, notes: "unknown" })).toBe(false);
  });

  it("bounds persisted numeric versions to PostgreSQL integer range", () => {
    expect(
      Check(QuestionBankQuestionSchema, {
        ...questionBankQuestion,
        contentVersion: 2_147_483_647,
      }),
    ).toBe(true);
    expect(
      Check(QuestionBankQuestionSchema, {
        ...questionBankQuestion,
        contentVersion: 2_147_483_648,
      }),
    ).toBe(false);
    expect(
      Check(QuestionBankImportSchema, {
        schemaVersion: "1.0",
        sourceName: "reviewed-bank",
        sourceVersion: 2_147_483_648,
        importedAt: now,
        questions: [questionBankQuestion],
      }),
    ).toBe(false);
  });
});

describe("structured evaluation schema", () => {
  const evaluation = {
    classification: "relevant",
    rubricItems: [
      {
        rubricItemId: "go.context.001.cancel",
        evidenceMaterialIds: ["answer-1"],
        awardedPoints: 50,
        missingOrIncorrectPoints: [],
      },
    ],
    recommendedFollowUp: {
      goalId: "go.context.001.follow-up",
      kind: "depth",
      purpose: "depth",
    },
    metadata: modelMetadata,
  };

  it("accepts evidence and complete model metadata", () => {
    expect(Check(StructuredAnswerEvaluationSchema, evaluation)).toBe(true);
  });

  it("rejects unstructured internal explanations", () => {
    expect(
      Check(StructuredAnswerEvaluationSchema, {
        ...evaluation,
        chainOfThought: "private reasoning",
      }),
    ).toBe(false);
  });
});

describe("internal and public report schemas", () => {
  it("keeps immutable internal metadata and evidence out of public responses", () => {
    expect(
      Check(InternalCompleteReportSnapshotSchema, {
        kind: "complete",
        ...internalReport,
        overallScore: 80,
      }),
    ).toBe(true);
    expect(
      Check(CompleteReportResponseSchema, {
        kind: "complete",
        ...publicReport,
        overallScore: 80,
      }),
    ).toBe(true);

    const internalFields = [
      "questionId",
      "questionVersion",
      "rubricItemId",
      "awardedPoints",
      "evidence",
      "modelMetadata",
      "questionVersions",
      "schemaVersion",
      "sourceWording",
      "questionType",
      "reviewed",
      "reviewMetadata",
      "referenceAnswer",
      "followUpGoals",
      "knowledgeExplanation",
    ];
    for (const field of internalFields) {
      const leaked =
        field === "modelMetadata" || field === "questionVersions" || field === "schemaVersion"
          ? { kind: "complete", ...publicReport, overallScore: 80, [field]: "private" }
          : {
              kind: "complete",
              ...publicReport,
              overallScore: 80,
              questions: publicReportQuestions.map((question, index) =>
                index === 0 ? { ...question, [field]: "private" } : question,
              ),
            };
      expect(Check(CompleteReportResponseSchema, leaked), field).toBe(false);
    }
  });

  it("discriminates positive scored outcomes from matching zero-score reasons", () => {
    expect(Check(PublicReportQuestionFeedbackSchema, publicReportQuestion)).toBe(true);
    expect(Check(PublicReportQuestionFeedbackSchema, { ...publicReportQuestion, score: 0 })).toBe(
      false,
    );
    expect(
      Check(PublicReportQuestionFeedbackSchema, {
        ...publicReportQuestion,
        outcome: "unknown",
        score: 0,
        zeroScoreReason: "unknown",
      }),
    ).toBe(true);
    expect(
      Check(PublicReportQuestionFeedbackSchema, {
        ...publicReportQuestion,
        outcome: "unknown",
        score: 0,
        zeroScoreReason: "skipped",
      }),
    ).toBe(false);
    expect(
      Check(InternalCompleteReportSnapshotSchema, {
        kind: "complete",
        ...internalReport,
        overallScore: 0,
        questions: internalReportQuestions.map((question, index) =>
          index === 0
            ? {
                ...question,
                outcome: "skipped",
                score: 0,
                zeroScoreReason: "unknown",
              }
            : question,
        ),
      }),
    ).toBe(false);
  });

  it("requires complete reports to contain exactly 5, 10, or 15 feedback items", () => {
    const fiveQuestionReport = {
      kind: "complete",
      ...publicReport,
      overallScore: 80,
    };
    expect(Check(CompleteReportResponseSchema, fiveQuestionReport)).toBe(true);
    expect(
      Check(CompleteReportResponseSchema, {
        ...fiveQuestionReport,
        questions: [publicReportQuestion],
      }),
    ).toBe(false);

    for (const questionCount of [10, 15]) {
      expect(
        Check(CompleteReportResponseSchema, {
          ...fiveQuestionReport,
          domains: allAssessedDomains,
          questions: Array.from({ length: questionCount }, (_, index) => ({
            ...publicReportQuestion,
            position: index + 1,
          })),
        }),
      ).toBe(true);
    }
  });

  it("requires five assessed domains for 5 questions and all domains for 10 or 15", () => {
    const complete = {
      kind: "complete",
      ...publicReport,
      overallScore: 80,
    };
    expect(
      Check(CompleteReportResponseSchema, {
        ...complete,
        domains: incompleteDomains.map((domain) => ({
          status: "unassessed",
          domain: domain.domain,
        })),
      }),
    ).toBe(false);
    expect(
      Check(CompleteReportResponseSchema, {
        ...complete,
        domains: incompleteDomains,
        questions: Array.from({ length: 10 }, (_, index) => ({
          ...publicReportQuestion,
          position: index + 1,
        })),
      }),
    ).toBe(false);
  });

  it("requires six unique domain results and detects coverage JSON Schema cannot express", () => {
    const complete = {
      kind: "complete",
      ...publicReport,
      overallScore: 80,
    };
    expect(validateReportResponse(complete)).toEqual([]);

    const duplicateDomains = [
      ...domains.slice(0, 5),
      {
        status: "unassessed",
        domain: "go_language",
      },
    ];
    const issues = validateReportResponse({ ...complete, domains: duplicateDomains });
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "duplicate_domain" }),
        expect.objectContaining({ code: "missing_domain" }),
      ]),
    );
  });

  it("agrees with domain validation on complete-report domain coverage", () => {
    const questions = internalReportQuestions.map((question, index) =>
      index === 4 ? { ...question, domain: "go_language" as const } : question,
    );
    const invalidDomains = incompleteDomains.map((result, index) =>
      index === 0
        ? { status: "assessed" as const, domain: result.domain, score: 80, questionCount: 2 }
        : index < 4
          ? { status: "assessed" as const, domain: result.domain, score: 80, questionCount: 1 }
          : { status: "unassessed" as const, domain: result.domain },
    );
    const snapshot = {
      kind: "complete",
      ...internalReport,
      domains: invalidDomains,
      questions,
      overallScore: 80,
    } as const;

    expect(validateImmutableReportSnapshot(snapshot)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "inconsistent_domain_question_count" }),
      ]),
    );
    expect(validateInternalReportSnapshot(snapshot)).not.toEqual([]);
  });

  it.each(["1", "2026-08-01", "2026-08-01T00:00:00+24:00", "2026-08-01T00:00:00+08:60"])(
    "rejects non-canonical report timestamp %s",
    (generatedAt) => {
      const internal = {
        kind: "complete",
        ...internalReport,
        generatedAt,
        overallScore: 80,
      };
      const publicValue = {
        kind: "complete",
        ...publicReport,
        generatedAt,
        overallScore: 80,
      };
      expect(Check(InternalCompleteReportSnapshotSchema, internal)).toBe(false);
      expect(Check(CompleteReportResponseSchema, publicValue)).toBe(false);
      expect(validateInternalReportSnapshot(internal)).not.toEqual([]);
      expect(validateReportResponse(publicValue)).not.toEqual([]);
    },
  );

  it.each(["2026-08-01T00:00:00Z", "2026-08-01T08:00:00.123+08:00"])(
    "accepts canonical report timestamp %s",
    (generatedAt) => {
      const internal = {
        kind: "complete",
        ...internalReport,
        generatedAt,
        overallScore: 80,
      };
      const publicValue = {
        kind: "complete",
        ...publicReport,
        generatedAt,
        overallScore: 80,
      };
      expect(validateInternalReportSnapshot(internal)).toEqual([]);
      expect(validateReportResponse(publicValue)).toEqual([]);
    },
  );

  it("requires complete and incomplete feedback positions to be unique and contiguous", () => {
    const complete = {
      kind: "complete",
      ...publicReport,
      overallScore: 80,
      questions: publicReportQuestions.map((question, index) => ({
        ...question,
        position: index === 1 ? 1 : question.position,
      })),
    };
    expect(validateReportResponse(complete)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "duplicate_position" }),
        expect.objectContaining({ code: "non_contiguous_position" }),
      ]),
    );

    const incomplete = {
      kind: "incomplete",
      ...publicReport,
      domains: [
        {
          status: "assessed",
          domain: "go_language",
          score: 80,
          questionCount: 2,
        },
        ...incompleteDomains.slice(1),
      ],
      questions: [
        publicReportQuestion,
        {
          ...publicReportQuestion,
          position: 1,
        },
      ],
    };
    expect(validateReportResponse(incomplete)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "duplicate_position" }),
        expect.objectContaining({ code: "non_contiguous_position" }),
      ]),
    );

    const internalIncomplete = {
      kind: "incomplete",
      ...internalReport,
      domains: incomplete.domains,
      questions: [
        internalReportQuestion,
        {
          ...internalReportQuestion,
          questionId: "go.context.002",
          position: 1,
        },
      ],
      questionVersions: [
        {
          questionId: internalReportQuestion.questionId,
          questionVersion: internalReportQuestion.questionVersion,
        },
        {
          questionId: "go.context.002",
          questionVersion: internalReportQuestion.questionVersion,
        },
      ],
    };
    expect(validateInternalReportSnapshot(internalIncomplete)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "duplicate_position" }),
        expect.objectContaining({ code: "non_contiguous_position" }),
      ]),
    );
  });

  it("limits incomplete reports to at most 15 question feedback items", () => {
    const publicQuestions = Array.from({ length: 16 }, (_, index) => ({
      ...publicReportQuestion,
      position: index + 1,
    }));
    const internalQuestions = Array.from({ length: 16 }, (_, index) => ({
      ...internalReportQuestion,
      questionId: `go.incomplete.${index + 1}`,
      position: index + 1,
    }));

    expect(
      Check(IncompleteReportResponseSchema, {
        kind: "incomplete",
        ...publicReport,
        domains: incompleteDomains,
        questions: publicQuestions,
      }),
    ).toBe(false);
    expect(
      Check(InternalIncompleteReportSnapshotSchema, {
        kind: "incomplete",
        ...internalReport,
        domains: incompleteDomains,
        questions: internalQuestions,
        questionVersions: internalQuestions.map((question) => ({
          questionId: question.questionId,
          questionVersion: question.questionVersion,
        })),
      }),
    ).toBe(false);
  });

  it("rejects assessed domain counts inconsistent with question feedback", () => {
    const inconsistentDomains = domains.map((domain, index) =>
      index === 0 && domain.status === "assessed"
        ? { ...domain, questionCount: domain.questionCount + 1 }
        : domain,
    );
    expect(
      validateReportResponse({
        kind: "complete",
        ...publicReport,
        domains: inconsistentDomains,
        overallScore: 80,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "inconsistent_domain_question_count" }),
      ]),
    );

    const internallyMisassigned = {
      kind: "complete",
      ...internalReport,
      domains,
      questions: internalReportQuestions.map((question, index) =>
        index === 0 ? { ...question, domain: "concurrency_runtime_performance" } : question,
      ),
      overallScore: 80,
    };
    expect(validateInternalReportSnapshot(internallyMisassigned)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "inconsistent_domain_question_count" }),
      ]),
    );
  });

  it("requires internal question-version metadata to cover each question exactly once", () => {
    const complete = {
      kind: "complete",
      ...internalReport,
      questionVersions: internalReport.questionVersions.slice(1),
      overallScore: 80,
    };
    expect(validateInternalReportSnapshot(complete)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "missing_question_version" })]),
    );

    const incomplete = {
      kind: "incomplete",
      ...internalReport,
      domains: incompleteDomains,
      questions: [internalReportQuestion],
      questionVersions: [
        {
          questionId: internalReportQuestion.questionId,
          questionVersion: internalReportQuestion.questionVersion,
        },
        {
          questionId: internalReportQuestion.questionId,
          questionVersion: internalReportQuestion.questionVersion + 1,
        },
      ],
    };
    expect(validateInternalReportSnapshot(incomplete)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "duplicate_question_version" })]),
    );
  });

  it("requires overall score only for complete reports", () => {
    expect(
      Check(InternalCompleteReportSnapshotSchema, {
        kind: "complete",
        ...internalReport,
        overallScore: 0,
      }),
    ).toBe(true);
    expect(
      Check(InternalIncompleteReportSnapshotSchema, {
        kind: "incomplete",
        ...internalReport,
        domains: incompleteDomains,
        questions: [internalReportQuestion],
      }),
    ).toBe(true);
    expect(
      Check(IncompleteReportResponseSchema, {
        kind: "incomplete",
        ...publicReport,
        domains: incompleteDomains,
        questions: [publicReportQuestion],
        overallScore: 80,
      }),
    ).toBe(false);
    expect(
      validateInternalReportSnapshot({
        kind: "incomplete",
        ...internalReport,
        domains: incompleteDomains,
        questions: [internalReportQuestion],
        questionVersions: [
          {
            questionId: internalReportQuestion.questionId,
            questionVersion: internalReportQuestion.questionVersion,
          },
        ],
      }),
    ).toEqual([]);
  });
});

describe("startup configuration schema", () => {
  const commonEnvironment = {
    DATABASE_URL: "postgres://localhost:5432/interview",
    BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
    BETTER_AUTH_URL: "http://localhost:3000",
    MODEL_ID: "test-model",
    NODE_ENV: "test",
  };

  it("allows Faux Provider without an API key", () => {
    expect(
      Check(ServerEnvironmentSchema, {
        ...commonEnvironment,
        MODEL_PROVIDER: "faux",
      }),
    ).toBe(true);
    expect(
      Check(ServerEnvironmentSchema, {
        ...commonEnvironment,
        MODEL_PROVIDER: "faux",
        MODEL_API_KEY: "unused-secret",
      }),
    ).toBe(false);
  });

  it("requires a non-empty API key for every real provider", () => {
    expect(
      Check(ServerEnvironmentSchema, {
        ...commonEnvironment,
        MODEL_PROVIDER: "openai",
      }),
    ).toBe(false);
    expect(
      Check(ServerEnvironmentSchema, {
        ...commonEnvironment,
        MODEL_PROVIDER: "custom-provider",
        MODEL_API_KEY: "secret-key",
        MODEL_BASE_URL: "https://models.example.test/v1",
      }),
    ).toBe(true);
  });

  it("rejects unrelated properties and reports invalid required configuration", () => {
    const invalidEnvironment = {
      ...commonEnvironment,
      MODEL_PROVIDER: "faux",
      BETTER_AUTH_SECRET: "short",
      PATH: "/usr/bin",
    };
    const errors = [...Errors(ServerEnvironmentSchema, invalidEnvironment)];

    expect(Check(ServerEnvironmentSchema, invalidEnvironment)).toBe(false);
    expect(errors.some((error) => error.instancePath === "/BETTER_AUTH_SECRET")).toBe(true);
  });
});
