import type {
  PublicReportQuestionFeedbackDto,
  ReportResponseDto,
} from "@interview-agent/contracts/reports";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { Button } from "../components/button.js";
import { ErrorState, LoadingState } from "../components/page-state.js";
import { useCurrentAccount } from "../features/account/account-query.js";
import { getInterviewReport } from "../features/interview/interview-api.js";
import { ACCOUNT_OWNED_QUERY_KEY } from "../features/interview/interview-query.js";
import { ApiClientError } from "../lib/api-client.js";

const DOMAIN_LABELS = {
  go_language: "Go 语言与标准库",
  concurrency_runtime_performance: "并发、运行时与性能",
  http_rpc_api: "HTTP、RPC 与 API",
  database_storage: "数据库与存储",
  cache_messaging_distributed: "缓存、消息与分布式",
  testing_observability_engineering: "测试、可观测性与工程实践",
} as const;

export function ReportPage() {
  const { interviewId } = useParams();
  const account = useCurrentAccount();
  const report = useQuery({
    queryKey: [
      ...ACCOUNT_OWNED_QUERY_KEY,
      account.data?.id ?? "signed-out",
      "report",
      interviewId ?? "missing",
    ],
    queryFn: ({ signal }) => getInterviewReport(interviewId ?? "", signal),
    enabled: account.data !== undefined && interviewId !== undefined,
  });

  if (account.isPending) {
    return <LoadingState label="正在检查账户状态" />;
  }
  if (account.isError) {
    const signedOut = account.error instanceof ApiClientError && account.error.status === 401;
    return (
      <ErrorState
        {...(signedOut ? { description: "登录后可以查看面试报告。" } : {})}
        title={signedOut ? "需要登录" : "账户状态加载失败"}
      />
    );
  }
  if (report.isPending) {
    return <LoadingState label="正在加载面试报告" />;
  }
  if (report.isError) {
    return <ErrorState title="面试报告加载失败" />;
  }
  return <ReportView report={report.data} />;
}

function ReportView({ report }: { readonly report: ReportResponseDto }) {
  return (
    <article className="mx-auto max-w-6xl">
      <header className="rounded-[2rem] bg-ink-950 p-7 text-paper-50 shadow-xl sm:p-10">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="max-w-3xl">
            <p className="text-xs font-black tracking-[0.18em] text-paper-100/65">
              {report.kind === "complete" ? "COMPLETE REPORT" : "INCOMPLETE REPORT"}
            </p>
            <h2 className="mt-5 text-4xl font-black tracking-[-0.04em]">
              {report.kind === "complete" ? "完整面试报告" : "不完整面试报告"}
            </h2>
            <p className="mt-5 text-sm leading-7 text-paper-100/75">{report.overallExplanation}</p>
          </div>
          {report.kind === "complete" ? (
            <div className="rounded-3xl bg-white/10 px-7 py-6 text-center">
              <p className="text-5xl font-black">{report.overallScore}</p>
              <p className="mt-2 text-xs text-paper-100/65">总分 / 100</p>
            </div>
          ) : (
            <p className="rounded-full border border-white/20 px-4 py-2 text-sm font-bold">
              不提供总分
            </p>
          )}
        </div>
        <p className="mt-7 text-xs text-paper-100/55">
          本报告生成后保持只读，不支持重新评分、继续对话、导出或公开分享。
        </p>
      </header>

      <section className="mt-8">
        <h3 className="text-2xl font-black">领域表现</h3>
        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {report.domains.map((domain) => (
            <div className="rounded-3xl border border-black/10 bg-white/70 p-5" key={domain.domain}>
              <p className="text-sm font-black">{DOMAIN_LABELS[domain.domain]}</p>
              {domain.status === "assessed" ? (
                <>
                  <p className="mt-4 text-3xl font-black">{domain.score}</p>
                  <p className="mt-1 text-xs text-ink-700">{domain.questionCount} 道已评估题目</p>
                </>
              ) : (
                <p className="mt-4 text-sm font-bold text-ink-700">本场未评估</p>
              )}
            </div>
          ))}
        </div>
      </section>

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <SummarySection title="优势" items={report.strengths} />
        <SummarySection title="需要改进" items={report.weaknesses} />
        <SummarySection title="优先事项" items={report.priorities} />
        <SummarySection title="学习建议" items={report.learningSuggestions} />
      </div>

      <section className="mt-10">
        <h3 className="text-2xl font-black">逐题反馈</h3>
        <ol className="mt-5 space-y-6">
          {report.questions.map((question) => (
            <li key={question.position}>
              <QuestionFeedback question={question} />
            </li>
          ))}
        </ol>
      </section>

      <div className="mt-9 flex flex-wrap gap-3">
        <Button asChild tone="secondary">
          <Link to={`/interviews/${report.interviewId}`}>查看面试记录</Link>
        </Button>
        <Button asChild tone="secondary">
          <Link to="/history">返回历史</Link>
        </Button>
      </div>
    </article>
  );
}

function SummarySection({
  items,
  title,
}: {
  readonly items: readonly string[];
  readonly title: string;
}) {
  return (
    <section className="rounded-3xl border border-black/10 bg-white/70 p-6">
      <h3 className="font-black">{title}</h3>
      <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-7 text-ink-700">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

function QuestionFeedback({ question }: { readonly question: PublicReportQuestionFeedbackDto }) {
  return (
    <article className="rounded-[2rem] border border-black/10 bg-white/75 p-6 shadow-sm sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-3xl">
          <p className="text-xs font-black text-brand-700">第 {question.position} 题</p>
          <h4 className="mt-3 text-xl font-black leading-8">{question.displayedQuestion}</h4>
        </div>
        <div className="text-right">
          <p className="text-3xl font-black">{question.score}</p>
          <p className="text-xs text-ink-700">{outcomeLabel(question.outcome)}</p>
        </div>
      </div>
      <p className="mt-5 text-sm leading-7 text-ink-700">{question.answerSummary}</p>
      <p className="mt-4 rounded-2xl bg-paper-100 p-4 text-sm leading-7">
        {question.scoreRationale}
      </p>
      <FeedbackList title="已体现知识点" items={question.matchedKnowledgePoints} />
      <FeedbackList title="缺失或错误知识点" items={question.missingOrIncorrectPoints} />
      <FeedbackList title="改进建议" items={question.improvementSuggestions} />
    </article>
  );
}

function FeedbackList({
  items,
  title,
}: {
  readonly items: readonly string[];
  readonly title: string;
}) {
  if (items.length === 0) {
    return null;
  }
  return (
    <section className="mt-5">
      <h5 className="text-sm font-black">{title}</h5>
      <ul className="mt-2 list-disc space-y-2 pl-5 text-sm leading-7 text-ink-700">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

function outcomeLabel(outcome: PublicReportQuestionFeedbackDto["outcome"]): string {
  switch (outcome) {
    case "scored":
      return "已评分";
    case "incorrect":
      return "回答错误";
    case "unknown":
      return "未掌握";
    case "skipped":
      return "已跳过";
    case "irrelevant":
      return "答非所问";
  }
}
