import type { InterviewHistoryItemDto } from "@interview-agent/contracts/responses";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { Button } from "../components/button.js";
import { EmptyState, ErrorState, LoadingState } from "../components/page-state.js";
import { useCurrentAccount } from "../features/account/account-query.js";
import { getInterviewHistory } from "../features/interview/interview-api.js";
import { historyQueryKey } from "../features/interview/interview-query.js";
import { ApiClientError } from "../lib/api-client.js";

export function HistoryPage() {
  const account = useCurrentAccount();
  const history = useInfiniteQuery({
    queryKey: historyQueryKey(account.data?.id ?? "signed-out"),
    queryFn: ({ pageParam, signal }) => getInterviewHistory(pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => (page.pageInfo.hasMore ? page.pageInfo.nextCursor : undefined),
    enabled: account.data !== undefined,
    refetchOnMount: "always",
  });

  if (account.isPending) {
    return <LoadingState label="正在检查账户状态" />;
  }
  if (account.isError) {
    const signedOut = account.error instanceof ApiClientError && account.error.status === 401;
    return (
      <ErrorState
        {...(signedOut ? { description: "登录后可以查看历史面试。" } : {})}
        title={signedOut ? "需要登录" : "账户状态加载失败"}
      />
    );
  }
  if (history.isPending) {
    return <LoadingState label="正在加载面试历史" />;
  }
  if (history.isError) {
    return <ErrorState title="面试历史加载失败" />;
  }
  const items = history.data.pages.flatMap((page) => page.items);
  return (
    <div className="mx-auto max-w-5xl">
      <header>
        <p className="text-xs font-black tracking-[0.18em] text-brand-700">HISTORY</p>
        <h2 className="mt-4 text-4xl font-black tracking-[-0.04em]">面试历史</h2>
        <p className="mt-4 text-sm leading-7 text-ink-700">
          已结束的面试按时间倒序排列，记录和报告保持只读。
        </p>
      </header>

      {items.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            description="完成、提前结束或放弃面试后，会在这里留下记录。"
            title="暂无历史面试"
          />
        </div>
      ) : (
        <ol className="mt-8 space-y-4">
          {items.map((item) => (
            <li key={item.id}>
              <HistoryCard item={item} />
            </li>
          ))}
        </ol>
      )}
      {history.hasNextPage ? (
        <Button
          className="mt-7"
          disabled={history.isFetching}
          onClick={() => {
            if (!history.isFetching) {
              void history.fetchNextPage();
            }
          }}
          tone="secondary"
        >
          {history.isFetchingNextPage ? "正在加载…" : "加载更多"}
        </Button>
      ) : null}
    </div>
  );
}

function HistoryCard({ item }: { readonly item: InterviewHistoryItemDto }) {
  return (
    <article className="rounded-3xl border border-black/10 bg-white/70 p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-black tracking-[0.14em] text-brand-700">
            {statusLabel(item.status)}
          </p>
          <h3 className="mt-2 text-xl font-black">Go 后端 · {item.questionCount} 题</h3>
          <p className="mt-2 text-xs text-ink-700">{formatDate(item.endedAt)}</p>
        </div>
        {item.status === "completed" ? (
          <p className="text-3xl font-black text-ink-950">{item.overallScore}</p>
        ) : null}
      </div>
      <div className="mt-5 flex gap-4 text-sm font-bold">
        <Link className="underline underline-offset-4" to={`/interviews/${item.id}`}>
          查看面试记录
        </Link>
        {"reportId" in item ? (
          <Link className="underline underline-offset-4" to={`/reports/${item.id}`}>
            查看报告
          </Link>
        ) : null}
      </div>
    </article>
  );
}

function statusLabel(status: InterviewHistoryItemDto["status"]): string {
  switch (status) {
    case "completed":
      return "已完成";
    case "early_ended":
      return "提前结束";
    case "abandoned":
      return "已放弃";
  }
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "long",
    timeStyle: "short",
  }).format(new Date(value));
}
