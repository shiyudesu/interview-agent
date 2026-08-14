import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import * as RadioGroup from "radix-ui/radio-group";
import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { Button } from "../components/button.js";
import { ErrorState, LoadingState } from "../components/page-state.js";
import { useCurrentAccount } from "../features/account/account-query.js";
import {
  abandonInterview,
  createInterview,
  getActiveInterview,
} from "../features/interview/interview-api.js";
import {
  activeInterviewQueryKey,
  historyQueryKey,
  useActiveInterview,
} from "../features/interview/interview-query.js";
import { ApiClientError } from "../lib/api-client.js";

const QUESTION_COUNTS = [
  { value: 5, duration: "约 20 分钟", description: "覆盖五个不同知识领域" },
  { value: 10, duration: "约 40 分钟", description: "覆盖全部六个知识领域" },
  { value: 15, duration: "约 60 分钟", description: "更完整的综合评估" },
] as const;

export function InterviewCreationPage() {
  const account = useCurrentAccount();
  const activeInterview = useActiveInterview(account.data?.id);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const createIdempotencyKey = useRef<string | null>(null);
  const abandonIdempotencyKey = useRef<string | null>(null);
  const [questionCount, setQuestionCount] = useState<5 | 10 | 15>(5);
  const create = useMutation({
    mutationFn: () => createInterview(questionCount, logicalCommandKey(createIdempotencyKey)),
    async onSuccess() {
      createIdempotencyKey.current = null;
      const current = await refreshActiveInterview(
        queryClient,
        requiredAccountId(account.data?.id),
      );
      if (current !== null) {
        navigate(`/interviews/${current.id}`);
      }
    },
    async onError() {
      const current = await refreshActiveInterview(
        queryClient,
        requiredAccountId(account.data?.id),
      );
      if (current !== null) {
        createIdempotencyKey.current = null;
        navigate(`/interviews/${current.id}`);
      }
    },
  });
  const abandon = useMutation({
    mutationFn: (interview: NonNullable<typeof activeInterview.data>) =>
      abandonInterview(interview.id, interview.version, logicalCommandKey(abandonIdempotencyKey)),
    async onSuccess() {
      abandonIdempotencyKey.current = null;
      await refreshActiveInterview(queryClient, requiredAccountId(account.data?.id));
    },
    async onError() {
      const previous = activeInterview.data;
      const current = await refreshActiveInterview(
        queryClient,
        requiredAccountId(account.data?.id),
      );
      if (
        current === null ||
        previous == null ||
        current.id !== previous.id ||
        current.version !== previous.version
      ) {
        abandonIdempotencyKey.current = null;
      }
    },
  });

  if (account.isPending) {
    return <LoadingState label="正在检查账户状态" />;
  }
  if (account.isError) {
    const signedOut = account.error instanceof ApiClientError && account.error.status === 401;
    return signedOut ? (
      <div className="mx-auto max-w-3xl">
        <ErrorState description="请先登录，再创建或恢复面试。" title="需要登录" />
        <Button asChild className="mt-5">
          <Link to="/sign-in">前往登录</Link>
        </Button>
      </div>
    ) : (
      <ErrorState title="账户状态加载失败" />
    );
  }
  if (activeInterview.isPending) {
    return <LoadingState label="正在检查面试状态" />;
  }
  if (activeInterview.isError) {
    return <ErrorState title="面试状态加载失败" />;
  }
  if (activeInterview.data !== null) {
    const interview = activeInterview.data;
    const canAbandon =
      interview.status === "active" &&
      interview.availableActions.some((action: string) => action === "abandon");
    return (
      <section className="mx-auto max-w-3xl rounded-[2rem] border border-black/10 bg-white/75 p-7 shadow-sm sm:p-10">
        <p className="text-xs font-black tracking-[0.18em] text-brand-700">ACTIVE INTERVIEW</p>
        <h2 className="mt-4 text-3xl font-black text-ink-950">你已有一场未结束的面试</h2>
        <p className="mt-4 text-sm leading-7 text-ink-700">
          当前进度为第 {interview.progress.current} / {interview.progress.total} 题。
          {canAbandon
            ? "开始新面试前，需要先恢复或明确放弃当前会话。"
            : "当前会话正在处理，完成或恢复后才能开始新面试。"}
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild>
            <Link to={`/interviews/${interview.id}`}>恢复当前面试</Link>
          </Button>
          {canAbandon ? (
            <Button
              disabled={abandon.isPending}
              onClick={() => abandon.mutate(interview)}
              tone="secondary"
            >
              {abandon.isPending ? "正在放弃…" : "放弃并创建新面试"}
            </Button>
          ) : null}
        </div>
        {abandon.error === null ? null : (
          <p className="mt-5 text-sm text-brand-700" role="alert">
            {abandon.error.message}
          </p>
        )}
      </section>
    );
  }

  return (
    <div className="mx-auto max-w-4xl">
      <header className="max-w-2xl">
        <p className="text-xs font-black tracking-[0.18em] text-brand-700">NEW INTERVIEW</p>
        <h2 className="mt-4 text-4xl font-black tracking-[-0.04em] text-ink-950">
          创建 Go 后端模拟面试
        </h2>
        <p className="mt-4 text-sm leading-7 text-ink-700">
          当前方向固定为中等难度 Go 后端。你只需选择主问题数量，题目会在开始时一次性冻结。
        </p>
      </header>

      <section className="mt-8 rounded-[2rem] border border-black/10 bg-white/75 p-6 shadow-sm sm:p-9">
        <h3 className="text-lg font-black text-ink-950">选择题量</h3>
        <RadioGroup.Root
          aria-label="面试题量"
          className="mt-5 grid gap-3 md:grid-cols-3"
          onValueChange={(value) => {
            createIdempotencyKey.current = null;
            setQuestionCount(parseQuestionCount(value));
          }}
          value={String(questionCount)}
        >
          {QUESTION_COUNTS.map((option) => (
            <label
              className="cursor-pointer rounded-3xl border border-black/10 bg-paper-50 p-5 has-[[data-state=checked]]:border-brand-600 has-[[data-state=checked]]:ring-2 has-[[data-state=checked]]:ring-brand-600/20"
              htmlFor={`question-count-${option.value}`}
              key={option.value}
            >
              <span className="flex items-center justify-between">
                <span className="text-2xl font-black">{option.value} 题</span>
                <RadioGroup.Item
                  className="grid size-5 place-items-center rounded-full border border-black/30"
                  id={`question-count-${option.value}`}
                  value={String(option.value)}
                >
                  <RadioGroup.Indicator className="size-2.5 rounded-full bg-brand-600" />
                </RadioGroup.Item>
              </span>
              <span className="mt-4 block text-sm font-bold text-ink-950">{option.duration}</span>
              <span className="mt-2 block text-xs leading-5 text-ink-700">
                {option.description}
              </span>
            </label>
          ))}
        </RadioGroup.Root>
        {create.error === null ? null : (
          <p className="mt-5 text-sm text-brand-700" role="alert">
            {create.error instanceof ApiClientError && create.error.status === 409
              ? "检测到另一场未结束的面试，请先恢复或放弃。"
              : create.error.message}
          </p>
        )}
        <Button className="mt-7" disabled={create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? "正在创建…" : `开始 ${questionCount} 题面试`}
        </Button>
      </section>
    </div>
  );
}

async function refreshActiveInterview(queryClient: QueryClient, accountId: string) {
  const queryKey = activeInterviewQueryKey(accountId);
  await Promise.all([
    queryClient.invalidateQueries({ queryKey }),
    queryClient.invalidateQueries({ queryKey: historyQueryKey(accountId) }),
  ]);
  return queryClient.fetchQuery({
    queryKey,
    queryFn: ({ signal }) => getActiveInterview(signal),
  });
}

function logicalCommandKey(reference: { current: string | null }): string {
  reference.current ??= crypto.randomUUID();
  return reference.current;
}

function requiredAccountId(accountId: string | undefined): string {
  if (accountId === undefined) {
    throw new Error("Authenticated account is unavailable");
  }
  return accountId;
}

function parseQuestionCount(value: string): 5 | 10 | 15 {
  const count = Number(value);
  if (count !== 5 && count !== 10 && count !== 15) {
    throw new Error("Unsupported interview question count");
  }
  return count;
}
