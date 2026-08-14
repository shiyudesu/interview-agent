import type {
  ActiveInterviewActionDto,
  InterviewDetailResponseDto,
  InterviewMessageDto,
} from "@interview-agent/contracts/responses";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { Button } from "../components/button.js";
import { ErrorState, LoadingState } from "../components/page-state.js";
import { useCurrentAccount } from "../features/account/account-query.js";
import { getInterviewDetail, runInterviewAction } from "../features/interview/interview-api.js";
import {
  activeInterviewQueryKey,
  historyQueryKey,
  interviewDetailQueryKey,
  useInterviewDetail,
} from "../features/interview/interview-query.js";
import { useOperationStream } from "../features/interview/use-operation-stream.js";
import { ApiClientError } from "../lib/api-client.js";

interface ActionInput {
  readonly action: ActiveInterviewActionDto;
  readonly operationId?: string;
  readonly text?: string;
}

export function ActiveInterviewPage() {
  const { interviewId } = useParams();
  const account = useCurrentAccount();
  const interview = useInterviewDetail(account.data?.id, interviewId);
  const queryClient = useQueryClient();
  const commandKeys = useRef(new Map<string, string>());
  const [answer, setAnswer] = useState("");
  const [supplement, setSupplement] = useState("");
  const [commandReconciled, setCommandReconciled] = useState(false);
  const canonicalPosition =
    interview.data?.status === "active" ? interview.data.progress.current : null;
  const streamedOperationId = currentProcessingOperationId(interview.data);
  const stream = useOperationStream({
    ...(account.data === undefined ? {} : { accountId: account.data.id }),
    ...(interviewId === undefined ? {} : { interviewId }),
    ...(streamedOperationId === undefined ? {} : { operationId: streamedOperationId }),
  });
  useEffect(() => {
    setAnswer("");
    setSupplement("");
  }, [canonicalPosition]);
  const command = useMutation({
    onMutate: () => setCommandReconciled(false),
    mutationFn: async (input: ActionInput) => {
      const current = requiredInterview(interview.data);
      const logicalId = commandLogicalId(current.version, input);
      let idempotencyKey = commandKeys.current.get(logicalId);
      if (idempotencyKey === undefined) {
        idempotencyKey = crypto.randomUUID();
        commandKeys.current.set(logicalId, idempotencyKey);
      }
      return {
        logicalId,
        operation: await runInterviewAction({
          ...input,
          expectedVersion: current.version,
          idempotencyKey,
          interviewId: current.id,
        }),
      };
    },
    async onSuccess({ logicalId }, input) {
      setCommandReconciled(false);
      commandKeys.current.delete(logicalId);
      if (input.action === "submit_answer") {
        setAnswer("");
      }
      if (input.action === "submit_supplement") {
        setSupplement("");
      }
      if (input.action === "mark_unknown" || input.action === "skip") {
        setAnswer("");
      }
      if (input.action === "continue") {
        setSupplement("");
      }
      await refreshInterview();
    },
    async onError(_error, input) {
      const attemptedVersion = interview.data?.version;
      const canonical = await refreshInterview();
      if (
        attemptedVersion !== undefined &&
        canonical !== undefined &&
        canonical.version !== attemptedVersion
      ) {
        setCommandReconciled(true);
        if (input.action === "submit_answer") {
          setAnswer("");
        }
        if (input.action === "submit_supplement") {
          setSupplement("");
        }
        commandKeys.current.delete(commandLogicalId(attemptedVersion, input));
      }
      if (
        input.action === "retry" &&
        attemptedVersion !== undefined &&
        canonical !== undefined &&
        canRetryFailedOperation(canonical)
      ) {
        commandKeys.current.delete(commandLogicalId(attemptedVersion, input));
      }
    },
  });

  async function refreshInterview() {
    if (account.data === undefined || interviewId === undefined) {
      return;
    }
    const detailQueryKey = interviewDetailQueryKey(account.data.id, interviewId);
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: activeInterviewQueryKey(account.data.id),
      }),
      queryClient.invalidateQueries({
        queryKey: historyQueryKey(account.data.id),
      }),
      queryClient.invalidateQueries({ queryKey: detailQueryKey }),
    ]);
    return queryClient.fetchQuery({
      queryKey: detailQueryKey,
      queryFn: ({ signal }) => getInterviewDetail(interviewId, signal),
    });
  }

  if (account.isPending) {
    return <LoadingState label="正在检查账户状态" />;
  }
  if (account.isError) {
    const signedOut = account.error instanceof ApiClientError && account.error.status === 401;
    return (
      <ErrorState
        {...(signedOut ? { description: "登录状态已失效，请重新登录。" } : {})}
        title={signedOut ? "需要登录" : "账户状态加载失败"}
      />
    );
  }
  if (interview.isPending) {
    return <LoadingState label="正在恢复面试" />;
  }
  if (interview.isError) {
    return <ErrorState title="面试加载失败" />;
  }

  const current = interview.data;
  if (current.status === "report_pending") {
    const retryOperationId =
      "operation" in current && current.operation.status === "failed"
        ? current.operation.operationId
        : undefined;
    return (
      <section className="mx-auto max-w-3xl rounded-[2rem] border border-black/10 bg-white/75 p-8 shadow-sm">
        <h2 className="text-3xl font-black">正在生成面试报告</h2>
        <p className="mt-4 text-sm leading-7 text-ink-700">
          已完成的题目和评价不会重新执行。报告生成失败时，可以仅重试报告分析。
        </p>
        {stream.reconnecting ? (
          <p className="mt-4 text-sm font-semibold text-ink-700" role="status">
            连接已中断，正在从权威状态恢复…
          </p>
        ) : null}
        {"operation" in current && current.operation.status === "failed" ? (
          <p
            className="mt-4 rounded-2xl bg-brand-600/10 px-4 py-3 text-sm text-brand-700"
            role="alert"
          >
            {current.operation.failure.message}
          </p>
        ) : null}
        <div className="mt-7 flex flex-wrap gap-3">
          {retryOperationId === undefined ? null : (
            <Button
              disabled={command.isPending || !hasAvailableAction(current, "retry")}
              onClick={() =>
                command.mutate({
                  action: "retry",
                  operationId: retryOperationId,
                })
              }
            >
              {command.isPending ? "正在重试…" : "重试报告生成"}
            </Button>
          )}
          <Button asChild tone="secondary">
            <Link to="/app">返回面试空间</Link>
          </Button>
        </div>
        {command.error === null || commandReconciled ? null : (
          <p className="mt-5 text-sm text-brand-700" role="alert">
            {command.error.message}
          </p>
        )}
      </section>
    );
  }
  if (
    current.status === "completed" ||
    current.status === "early_ended" ||
    current.status === "abandoned"
  ) {
    return <TerminalInterviewDetail interview={current} />;
  }
  if (current.status !== "active") {
    return (
      <section className="mx-auto max-w-3xl rounded-[2rem] border border-black/10 bg-white/75 p-8 shadow-sm">
        <h2 className="text-3xl font-black">本场面试已结束</h2>
        <p className="mt-4 text-sm leading-7 text-ink-700">
          当前状态：{current.status}。详细报告与历史入口将在后续页面接入。
        </p>
        <Button asChild className="mt-7" tone="secondary">
          <Link to="/app">返回面试空间</Link>
        </Button>
      </section>
    );
  }

  function TerminalInterviewDetail({
    interview,
  }: {
    readonly interview: Extract<
      InterviewDetailResponseDto,
      { readonly status: "completed" | "early_ended" | "abandoned" }
    >;
  }) {
    return (
      <div className="mx-auto max-w-4xl">
        <header className="rounded-[2rem] border border-black/10 bg-white/75 p-7 shadow-sm sm:p-10">
          <p className="text-xs font-black tracking-[0.18em] text-brand-700">
            {terminalStatusLabel(interview.status)}
          </p>
          <h2 className="mt-4 text-3xl font-black">Go 后端 · {interview.questionCount} 题</h2>
          <p className="mt-3 text-sm leading-7 text-ink-700">
            开始于 {formatInterviewDate(interview.startedAt)}，结束于{" "}
            {formatInterviewDate(interview.endedAt)}。
          </p>
          {"reportId" in interview ? (
            <Link
              className="mt-4 inline-block text-sm font-semibold text-moss-500 underline underline-offset-4"
              to={`/reports/${interview.id}`}
            >
              {interview.status === "completed" ? "查看完整报告" : "查看不完整报告"}
            </Link>
          ) : (
            <p className="mt-4 text-sm text-ink-700">本场面试未生成报告。</p>
          )}
        </header>
        <Transcript messages={interview.messages} />
        <Button asChild className="mt-7" tone="secondary">
          <Link to="/history">返回面试历史</Link>
        </Button>
      </div>
    );
  }

  const currentOperationBusy =
    "operation" in current &&
    (current.operation.status === "pending" || current.operation.status === "processing");
  const pending = command.isPending || current.phase === "processing" || currentOperationBusy;
  const retryOperationId =
    "operation" in current && current.operation.status === "failed"
      ? current.operation.operationId
      : undefined;
  return (
    <div className="mx-auto grid max-w-6xl gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <section className="min-w-0">
        <header className="rounded-[2rem] border border-black/10 bg-white/75 p-6 shadow-sm sm:p-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-black text-brand-700">
              第 {current.progress.current} / {current.progress.total} 题
            </p>
            <p className="text-xs font-bold text-ink-700">
              {currentOperationBusy ? "正在处理" : phaseLabel(current.phase)}
            </p>
          </div>
          <div
            aria-label={`面试进度 ${current.progress.current} / ${current.progress.total}`}
            className="mt-4 h-2 overflow-hidden rounded-full bg-paper-100"
            role="progressbar"
            aria-valuemax={current.progress.total}
            aria-valuemin={1}
            aria-valuenow={current.progress.current}
          >
            <div
              className="h-full rounded-full bg-brand-600 transition-[width]"
              style={{
                width: `${(current.progress.current / current.progress.total) * 100}%`,
              }}
            />
          </div>
          <h2 className="mt-8 text-2xl font-black leading-10 text-ink-950">
            {current.currentWording}
          </h2>
        </header>

        <Transcript messages={current.messages} />

        <div className="mt-6 rounded-[2rem] border border-black/10 bg-white/75 p-6 shadow-sm sm:p-8">
          {hasAction(current, "submit_answer") ? (
            <TextResponseForm
              label="你的回答"
              pending={pending}
              submitLabel="提交回答"
              text={answer}
              onTextChange={setAnswer}
              onSubmit={(text) => command.mutate({ action: "submit_answer", text })}
            />
          ) : null}
          {hasAction(current, "submit_supplement") ? (
            <TextResponseForm
              label="补充回答"
              pending={pending}
              submitLabel="提交补充"
              text={supplement}
              onTextChange={setSupplement}
              onSubmit={(text) => command.mutate({ action: "submit_supplement", text })}
            />
          ) : null}
          {current.phase === "processing" || currentOperationBusy ? (
            <p aria-live="polite" className="text-sm font-semibold text-ink-700" role="status">
              正在分析本次操作，页面刷新不会中断处理。
            </p>
          ) : null}
          {stream.reconnecting ? (
            <p className="mt-3 text-sm font-semibold text-ink-700" role="status">
              实时连接已中断，正在刷新权威状态并重连…
            </p>
          ) : null}
          {stream.text === null ? null : (
            <div aria-live="polite" className="mt-4 rounded-2xl bg-paper-100 p-4 text-sm leading-7">
              {stream.text}
            </div>
          )}
          {"operation" in current && current.operation.status === "failed" ? (
            <p
              className="mt-4 rounded-2xl bg-brand-600/10 px-4 py-3 text-sm text-brand-700"
              role="alert"
            >
              {current.operation.failure.message}
            </p>
          ) : null}

          <div className="mt-6 flex flex-wrap gap-3">
            <ActionButton
              action="request_clarification"
              label="澄清题意"
              current={current}
              disabled={pending}
              run={(action) => command.mutate({ action })}
            />
            <ActionButton
              action="mark_unknown"
              label="我不知道"
              current={current}
              disabled={pending}
              run={(action) => command.mutate({ action })}
            />
            <ActionButton
              action="skip"
              label="跳过本题"
              current={current}
              disabled={pending}
              run={(action) => command.mutate({ action })}
            />
            <ActionButton
              action="continue"
              label="继续下一题"
              current={current}
              disabled={pending}
              run={(action) => command.mutate({ action })}
            />
            <ActionButton
              action="end_early"
              label="提前结束并生成报告"
              current={current}
              disabled={pending}
              run={(action) => command.mutate({ action })}
            />
            <ActionButton
              action="abandon"
              label="放弃面试"
              current={current}
              disabled={pending}
              run={(action) => command.mutate({ action })}
            />
            {retryOperationId === undefined ? null : (
              <Button
                disabled={pending || !hasAction(current, "retry")}
                onClick={() =>
                  command.mutate({
                    action: "retry",
                    operationId: retryOperationId,
                  })
                }
                tone="secondary"
              >
                重试失败操作
              </Button>
            )}
          </div>
          {command.error === null || commandReconciled ? null : (
            <p className="mt-5 text-sm text-brand-700" role="alert">
              {command.error.message}
            </p>
          )}
        </div>
      </section>

      <aside className="lg:sticky lg:top-6 lg:self-start">
        <div className="rounded-3xl border border-black/10 bg-ink-950 p-6 text-paper-50">
          <h3 className="font-black">当前规则</h3>
          <ul className="mt-4 space-y-3 text-xs leading-6 text-paper-100/75">
            <li>已提交内容不可编辑，可在评估后补充。</li>
            <li>系统追问最多包含一次澄清和一次深挖。</li>
            <li>分数和知识领域会在报告中统一展示。</li>
          </ul>
        </div>
      </aside>
    </div>
  );
}

function Transcript({ messages }: { readonly messages: readonly InterviewMessageDto[] }) {
  return (
    <ol aria-label="面试记录" className="mt-6 space-y-4">
      {messages.map((message) => (
        <li
          className={[
            "max-w-[90%] rounded-3xl px-5 py-4 text-sm leading-7 shadow-sm",
            message.role === "user"
              ? "ml-auto bg-brand-600 text-white"
              : "border border-black/10 bg-white/75 text-ink-950",
          ].join(" ")}
          key={message.id}
        >
          <p className="mb-1 text-[0.65rem] font-black uppercase tracking-[0.16em] opacity-65">
            {messageLabel(message.kind)}
          </p>
          <p>{message.text}</p>
        </li>
      ))}
    </ol>
  );
}

function TextResponseForm({
  label,
  onSubmit,
  onTextChange,
  pending,
  submitLabel,
  text,
}: {
  readonly label: string;
  readonly onSubmit: (text: string) => void;
  readonly onTextChange: (text: string) => void;
  readonly pending: boolean;
  readonly submitLabel: string;
  readonly text: string;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = text.trim();
    if (normalized.length > 0) {
      onSubmit(normalized);
    }
  }
  return (
    <form onSubmit={submit}>
      <label className="text-sm font-black" htmlFor="interview-response">
        {label}
      </label>
      <textarea
        className="mt-3 min-h-40 w-full resize-y rounded-3xl border border-black/15 bg-white p-4 text-base leading-7"
        disabled={pending}
        id="interview-response"
        maxLength={20_000}
        onChange={(event) => onTextChange(event.currentTarget.value)}
        required
        value={text}
      />
      <Button className="mt-4" disabled={pending || text.trim().length === 0} type="submit">
        {pending ? "正在处理…" : submitLabel}
      </Button>
    </form>
  );
}

function ActionButton({
  action,
  current,
  disabled,
  label,
  run,
}: {
  readonly action: ActiveInterviewActionDto;
  readonly current: Extract<InterviewDetailResponseDto, { readonly status: "active" }>;
  readonly disabled: boolean;
  readonly label: string;
  readonly run: (action: ActiveInterviewActionDto) => void;
}) {
  return (
    <Button
      disabled={disabled || !hasAction(current, action)}
      onClick={() => run(action)}
      tone="secondary"
    >
      {label}
    </Button>
  );
}

function hasAction(
  current: Extract<InterviewDetailResponseDto, { readonly status: "active" }>,
  action: ActiveInterviewActionDto,
): boolean {
  return current.availableActions.some((candidate: string) => candidate === action);
}

function hasAvailableAction(
  current: Extract<InterviewDetailResponseDto, { readonly status: "active" | "report_pending" }>,
  action: ActiveInterviewActionDto,
): boolean {
  return current.availableActions.some((candidate: string) => candidate === action);
}

function canRetryFailedOperation(current: InterviewDetailResponseDto): boolean {
  return (
    (current.status === "active" || current.status === "report_pending") &&
    "operation" in current &&
    current.operation.status === "failed" &&
    current.availableActions.some((candidate: string) => candidate === "retry")
  );
}

function currentProcessingOperationId(
  current: InterviewDetailResponseDto | undefined,
): string | undefined {
  if (
    current === undefined ||
    (current.status !== "active" && current.status !== "report_pending") ||
    !("operation" in current) ||
    (current.operation.status !== "pending" && current.operation.status !== "processing")
  ) {
    return undefined;
  }
  return current.operation.operationId;
}

function commandLogicalId(version: number, input: ActionInput): string {
  return [version, input.action, input.operationId ?? "", input.text ?? ""].join("\0");
}

function requiredInterview(
  value: InterviewDetailResponseDto | undefined,
): InterviewDetailResponseDto {
  if (value === undefined) {
    throw new Error("Interview is unavailable");
  }
  return value;
}

function phaseLabel(phase: "awaiting_response" | "processing" | "awaiting_continue"): string {
  switch (phase) {
    case "awaiting_response":
      return "等待回答";
    case "processing":
      return "正在处理";
    case "awaiting_continue":
      return "可以补充或继续";
  }
  throw new Error("Unknown interview phase");
}

function messageLabel(kind: InterviewMessageDto["kind"]): string {
  switch (kind) {
    case "main_question":
      return "主问题";
    case "answer":
      return "回答";
    case "supplement":
      return "补充";
    case "clarification":
      return "题意澄清";
    case "follow_up":
      return "系统追问";
    case "transition":
      return "衔接";
  }
  throw new Error("Unknown interview message kind");
}

function terminalStatusLabel(status: "completed" | "early_ended" | "abandoned"): string {
  switch (status) {
    case "completed":
      return "已完成";
    case "early_ended":
      return "提前结束";
    case "abandoned":
      return "已放弃";
  }
}

function formatInterviewDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
