import { Link } from "react-router-dom";

import { Button } from "../components/button.js";

export function NotFoundPage() {
  return (
    <section className="mx-auto max-w-2xl rounded-[2rem] border border-black/10 bg-white/70 p-8 text-center shadow-sm sm:p-12">
      <p className="text-xs font-black tracking-[0.2em] text-brand-600">404</p>
      <h2 className="mt-5 text-3xl font-black text-ink-950">没有找到这个页面</h2>
      <p className="mt-4 text-sm leading-7 text-ink-700">地址可能已失效，或页面尚未开放。</p>
      <Button asChild className="mt-8">
        <Link to="/">返回首页</Link>
      </Button>
    </section>
  );
}
