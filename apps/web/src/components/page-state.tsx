import { useRouteError } from "react-router-dom";

import { Button } from "./button.js";

interface LoadingStateProps {
  readonly label?: string;
}

export function LoadingState({ label = "正在加载" }: LoadingStateProps) {
  return (
    <div
      aria-live="polite"
      className="flex min-h-48 items-center justify-center rounded-3xl border border-black/10 bg-white/65 p-8"
      role="status"
    >
      <span
        aria-hidden="true"
        className="mr-3 size-5 animate-spin rounded-full border-2 border-moss-500/25 border-t-moss-500"
      />
      <span className="text-sm font-semibold text-ink-700">{label}</span>
    </div>
  );
}

interface ErrorStateProps {
  readonly description?: string;
  readonly onRetry?: () => void;
  readonly title?: string;
}

export function ErrorState({
  description = "请求暂时无法完成，请稍后重试。",
  onRetry,
  title = "出现了问题",
}: ErrorStateProps) {
  return (
    <section
      className="rounded-3xl border border-brand-500/25 bg-white/80 p-6 shadow-sm sm:p-8"
      role="alert"
    >
      <p className="mb-2 text-xs font-black tracking-[0.18em] text-brand-600">REQUEST FAILED</p>
      <h2 className="text-xl font-black text-ink-950">{title}</h2>
      <p className="mt-3 max-w-2xl text-sm leading-7 text-ink-700">{description}</p>
      {onRetry === undefined ? null : (
        <Button className="mt-6" onClick={onRetry} tone="secondary">
          重新尝试
        </Button>
      )}
    </section>
  );
}

interface EmptyStateProps {
  readonly description: string;
  readonly title: string;
}

export function EmptyState({ description, title }: EmptyStateProps) {
  return (
    <section className="rounded-3xl border border-dashed border-black/20 bg-white/55 p-8 text-center">
      <p className="text-lg font-black text-ink-950">{title}</p>
      <p className="mx-auto mt-3 max-w-xl text-sm leading-7 text-ink-700">{description}</p>
    </section>
  );
}

export function RouteErrorState() {
  useRouteError();
  return (
    <div className="mx-auto max-w-3xl px-5 py-16 sm:px-8">
      <ErrorState
        description="页面加载失败。请返回首页；如果问题持续存在，请稍后重试。"
        title="页面无法显示"
      />
    </div>
  );
}
