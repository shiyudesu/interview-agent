import { EmptyState } from "../components/page-state.js";

export function WorkspacePage() {
  return (
    <div className="mx-auto max-w-3xl">
      <p className="mb-4 text-xs font-black tracking-[0.18em] text-brand-600">INTERVIEW SPACE</p>
      <h2 className="text-3xl font-black tracking-[-0.03em] text-ink-950">面试空间</h2>
      <p className="mt-3 mb-8 text-sm leading-7 text-ink-700">
        这里将承载身份状态、当前面试、历史记录和报告入口。
      </p>
      <EmptyState
        description="应用壳层已经就绪；认证和面试创建流程将在后续任务接入。"
        title="尚未接入账户状态"
      />
    </div>
  );
}
