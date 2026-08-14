import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { Button } from "../components/button.js";
import { ErrorState, LoadingState } from "../components/page-state.js";
import { ACCOUNT_QUERY_KEY, useCurrentAccount } from "../features/account/account-query.js";
import { authClient } from "../features/auth/auth-api.js";
import { ApiClientError } from "../lib/api-client.js";

export function AccountSettingsPage() {
  const account = useCurrentAccount();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const linkGitHub = useMutation({
    mutationFn: () =>
      authClient.beginGitHubLink(
        absoluteUrl("/settings?linked=github"),
        absoluteUrl("/auth/error"),
      ),
    onSuccess: (url) => window.location.assign(url),
  });
  const signOut = useMutation({
    mutationFn: () => authClient.signOut(),
    async onSuccess() {
      queryClient.removeQueries({ queryKey: ACCOUNT_QUERY_KEY });
      navigate("/sign-in", { replace: true });
    },
  });

  if (account.isPending) {
    return <LoadingState label="正在加载账户设置" />;
  }
  if (account.isError) {
    const signedOut = account.error instanceof ApiClientError && account.error.status === 401;
    return signedOut ? (
      <div>
        <ErrorState description="登录状态已失效，请重新登录。" title="需要登录" />
        <Button asChild className="mt-5">
          <Link to="/sign-in">前往登录</Link>
        </Button>
      </div>
    ) : (
      <ErrorState title="账户设置加载失败" />
    );
  }

  const githubLinked = account.data.linkedIdentities.some(({ provider }) => provider === "github");
  const mutationError = linkGitHub.error ?? signOut.error;
  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <header>
        <p className="text-xs font-black tracking-[0.18em] text-brand-700">ACCOUNT</p>
        <h2 className="mt-3 text-3xl font-black text-ink-950">账户设置</h2>
        <p className="mt-3 text-sm leading-7 text-ink-700">{account.data.email}</p>
      </header>

      {searchParams.get("linked") === "github" ? (
        <p
          className="rounded-2xl bg-moss-500/12 px-5 py-4 text-sm font-semibold text-ink-950"
          role="status"
        >
          GitHub 身份已完成绑定。
        </p>
      ) : null}

      <section className="rounded-3xl border border-black/10 bg-white/70 p-6 sm:p-8">
        <h3 className="text-xl font-black">登录方式</h3>
        <ul className="mt-5 space-y-3">
          {account.data.linkedIdentities.map((identity) => (
            <li
              className="flex items-center justify-between rounded-2xl bg-paper-100 px-4 py-3 text-sm"
              key={`${identity.provider}:${identity.providerAccountId}`}
            >
              <span className="font-bold">
                {identity.provider === "github" ? "GitHub" : "邮箱验证码"}
              </span>
              <span className="text-ink-700">{formatDate(identity.linkedAt)}</span>
            </li>
          ))}
        </ul>
        {githubLinked ? null : (
          <Button
            className="mt-6"
            disabled={linkGitHub.isPending}
            onClick={() => linkGitHub.mutate()}
            tone="secondary"
          >
            {linkGitHub.isPending ? "正在前往 GitHub…" : "绑定 GitHub"}
          </Button>
        )}
      </section>

      <section className="rounded-3xl border border-black/10 bg-white/70 p-6 sm:p-8">
        <h3 className="text-xl font-black">登录会话</h3>
        <ul className="mt-5 space-y-3">
          {account.data.sessions.map((session) => (
            <li className="rounded-2xl bg-paper-100 px-4 py-3 text-sm" key={session.id}>
              <div className="flex items-center justify-between gap-4">
                <span className="font-bold">{session.current ? "当前会话" : "其他会话"}</span>
                <span className="text-ink-700">有效至 {formatDate(session.expiresAt)}</span>
              </div>
              <p className="mt-2 truncate text-xs text-ink-700">
                {session.userAgent ?? "未知设备"}
              </p>
            </li>
          ))}
        </ul>
      </section>

      {mutationError === null ? null : (
        <p className="text-sm text-brand-700" role="alert">
          {mutationError.message}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button disabled={signOut.isPending} onClick={() => signOut.mutate()} tone="secondary">
          {signOut.isPending ? "正在退出…" : "退出登录"}
        </Button>
        <Link className="self-center text-sm font-bold underline underline-offset-4" to="/app">
          返回面试空间
        </Link>
      </div>
    </div>
  );
}

function absoluteUrl(path: string): string {
  return new URL(path, window.location.origin).toString();
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
