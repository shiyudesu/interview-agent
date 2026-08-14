import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";

import { Button } from "../components/button.js";
import { FormField } from "../components/form-field.js";
import { ACCOUNT_QUERY_KEY, useCurrentAccount } from "../features/account/account-query.js";
import { authClient } from "../features/auth/auth-api.js";

export function SignInPage() {
  const account = useCurrentAccount();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [otp, setOtp] = useState("");
  const [otpRequested, setOtpRequested] = useState(false);
  const sendOtp = useMutation({
    mutationFn: () => authClient.sendEmailOtp(email.trim()),
    onSuccess: () => setOtpRequested(true),
  });
  const verifyOtp = useMutation({
    mutationFn: () =>
      authClient.signInWithEmailOtp({
        email: email.trim(),
        otp: otp.trim(),
        ...(name.trim().length === 0 ? {} : { name: name.trim() }),
      }),
    async onSuccess() {
      await queryClient.invalidateQueries({ queryKey: ACCOUNT_QUERY_KEY });
      navigate("/app", { replace: true });
    },
  });
  const github = useMutation({
    mutationFn: () => authClient.beginGitHubSignIn(absoluteUrl("/app"), absoluteUrl("/auth/error")),
    onSuccess: (url) => window.location.assign(url),
  });

  if (account.isSuccess) {
    return <Navigate replace to="/app" />;
  }
  const error = sendOtp.error ?? verifyOtp.error ?? github.error;

  function submitEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (otpRequested) {
      verifyOtp.mutate();
    } else {
      sendOtp.mutate();
    }
  }

  return (
    <div className="mx-auto grid max-w-5xl gap-8 lg:grid-cols-[0.9fr_1.1fr]">
      <section className="rounded-[2rem] bg-ink-950 p-8 text-paper-50 sm:p-10">
        <p className="text-xs font-black tracking-[0.18em] text-paper-100/65">WELCOME BACK</p>
        <h2 className="mt-6 text-4xl font-black tracking-[-0.04em]">登录后继续你的面试。</h2>
        <p className="mt-5 text-sm leading-7 text-paper-100/75">
          会话保存在服务端。登录后可以恢复当前进度、查看历史记录和不可变报告。
        </p>
      </section>

      <section className="rounded-[2rem] border border-black/10 bg-white/75 p-6 shadow-sm sm:p-10">
        <h2 className="text-2xl font-black text-ink-950">登录或创建账户</h2>
        <p className="mt-2 text-sm leading-6 text-ink-700">
          使用 GitHub，或通过邮箱接收一次性验证码。
        </p>
        <Button
          className="mt-7 w-full"
          disabled={github.isPending}
          onClick={() => github.mutate()}
          tone="secondary"
        >
          {github.isPending ? "正在前往 GitHub…" : "使用 GitHub 继续"}
        </Button>

        <div className="my-7 flex items-center gap-3 text-xs text-ink-700">
          <span className="h-px flex-1 bg-black/10" />
          或使用邮箱
          <span className="h-px flex-1 bg-black/10" />
        </div>

        <form className="space-y-5" onSubmit={submitEmail}>
          <FormField
            autoComplete="email"
            disabled={otpRequested}
            label="邮箱地址"
            onChange={(event) => setEmail(event.currentTarget.value)}
            required
            type="email"
            value={email}
          />
          {otpRequested ? (
            <>
              <FormField
                autoComplete="name"
                hint="仅在首次创建账户时使用。"
                label="显示名称（可选）"
                onChange={(event) => setName(event.currentTarget.value)}
                value={name}
              />
              <FormField
                autoComplete="one-time-code"
                inputMode="numeric"
                label="6 位验证码"
                maxLength={6}
                minLength={6}
                onChange={(event) => setOtp(event.currentTarget.value.replace(/\D/gu, ""))}
                pattern="[0-9]{6}"
                required
                value={otp}
              />
            </>
          ) : null}
          {error === null ? null : (
            <p
              className="rounded-2xl bg-brand-600/10 px-4 py-3 text-sm text-brand-700"
              role="alert"
            >
              {error.message}
            </p>
          )}
          <Button
            className="w-full"
            disabled={sendOtp.isPending || verifyOtp.isPending}
            type="submit"
          >
            {otpRequested
              ? verifyOtp.isPending
                ? "正在验证…"
                : "验证并登录"
              : sendOtp.isPending
                ? "正在发送…"
                : "发送验证码"}
          </Button>
          {otpRequested ? (
            <button
              className="w-full text-sm font-bold text-ink-700 underline underline-offset-4"
              disabled={sendOtp.isPending}
              onClick={() => sendOtp.mutate()}
              type="button"
            >
              重新发送验证码
            </button>
          ) : null}
        </form>
      </section>
    </div>
  );
}

function absoluteUrl(path: string): string {
  return new URL(path, window.location.origin).toString();
}
