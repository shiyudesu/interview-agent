import { Link } from "react-router-dom";

import { Button } from "../components/button.js";
import { EmptyState, ErrorState, LoadingState } from "../components/page-state.js";
import { useCurrentAccount } from "../features/account/account-query.js";
import { ApiClientError } from "../lib/api-client.js";

export function WorkspacePage() {
  const account = useCurrentAccount();
  if (account.isPending) {
    return <LoadingState label="正在恢复账户状态" />;
  }
  if (account.isError) {
    const signedOut = account.error instanceof ApiClientError && account.error.status === 401;
    return signedOut ? (
      <div className="mx-auto max-w-3xl">
        <ErrorState description="登录后可以恢复面试、查看历史记录和报告。" title="尚未登录" />
        <Button asChild className="mt-5">
          <Link to="/sign-in">前往登录</Link>
        </Button>
      </div>
    ) : (
      <ErrorState title="账户状态加载失败" />
    );
  }
  return (
    <div className="mx-auto max-w-3xl">
      <p className="mb-4 text-xs font-black tracking-[0.18em] text-brand-600">INTERVIEW SPACE</p>
      <h2 className="text-3xl font-black tracking-[-0.03em] text-ink-950">
        {account.data.displayName === null ? "面试空间" : `${account.data.displayName}，欢迎回来`}
      </h2>
      <p className="mt-3 mb-8 text-sm leading-7 text-ink-700">
        这里将承载身份状态、当前面试、历史记录和报告入口。
      </p>
      <EmptyState
        description="账户已登录。面试创建流程将在下一项任务接入。"
        title="当前没有进行中的面试"
      />
    </div>
  );
}
