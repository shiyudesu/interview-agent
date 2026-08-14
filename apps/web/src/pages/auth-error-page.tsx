import { Link, useSearchParams } from "react-router-dom";

import { Button } from "../components/button.js";

const UNLINKED_ERRORS = new Set([
  "account_not_linked",
  "user_already_exists",
  "user_already_exists_use_another_email",
]);

export function AuthErrorPage() {
  const [searchParams] = useSearchParams();
  const code = (searchParams.get("error") ?? "").toLowerCase();
  const unlinked = UNLINKED_ERRORS.has(code);

  return (
    <section className="mx-auto max-w-2xl rounded-[2rem] border border-brand-600/20 bg-white/80 p-8 shadow-sm sm:p-12">
      <p className="text-xs font-black tracking-[0.18em] text-brand-700">AUTHENTICATION</p>
      <h2 className="mt-5 text-3xl font-black text-ink-950">
        {unlinked ? "这个 GitHub 身份尚未关联" : "登录没有完成"}
      </h2>
      <p className="mt-4 text-sm leading-7 text-ink-700">
        {unlinked
          ? "为避免按邮箱自动合并账户，请先使用原来的邮箱验证码登录，再到账户设置中主动绑定 GitHub。"
          : "认证流程被取消、过期或暂时失败。请返回登录页面重新尝试。"}
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Button asChild>
          <Link to="/sign-in">返回登录</Link>
        </Button>
      </div>
    </section>
  );
}
