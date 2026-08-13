import { Link } from "react-router-dom";

import { Button } from "../components/button.js";

const principles = [
  {
    label: "固定蓝图",
    detail: "开始后冻结题目顺序，恢复会话时保持一致。",
  },
  {
    label: "证据反馈",
    detail: "评分与建议围绕已提交的文字回答和结构化评价。",
  },
  {
    label: "可恢复",
    detail: "刷新页面或更换设备后，从 PostgreSQL 权威状态继续。",
  },
] as const;

export function HomePage() {
  return (
    <div className="grid gap-12 lg:grid-cols-[1.25fr_0.75fr] lg:items-start">
      <section>
        <p className="mb-5 text-xs font-black tracking-[0.2em] text-brand-600">
          TEXT-ONLY MOCK INTERVIEW
        </p>
        <h2 className="max-w-4xl text-4xl font-black leading-tight tracking-[-0.04em] text-ink-950 sm:text-6xl">
          把每一次回答，
          <span className="block text-brand-500">变成下一次进步的证据。</span>
        </h2>
        <p className="mt-6 max-w-2xl text-base leading-8 text-ink-700 sm:text-lg">
          面向 Go 后端方向的文字模拟面试。题目、作答、恢复与报告都围绕同一个可追踪会话展开。
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild>
            <Link to="/app">进入面试空间</Link>
          </Button>
          <a
            className="inline-flex min-h-11 items-center rounded-full px-4 text-sm font-bold text-ink-700 underline decoration-black/20 underline-offset-4 hover:text-ink-950"
            href="#principles"
          >
            了解工作方式
          </a>
        </div>
      </section>

      <aside className="rounded-[2rem] border border-black/10 bg-ink-950 p-6 text-paper-50 shadow-xl shadow-black/10 sm:p-8">
        <p className="text-xs font-black tracking-[0.18em] text-paper-100/70">CURRENT SCOPE</p>
        <p className="mt-6 text-3xl font-black">Go 后端</p>
        <p className="mt-3 text-sm leading-7 text-paper-100/75">
          当前 MVP 专注中等难度、纯文字形式和 5 / 10 / 15 道固定题量。
        </p>
        <dl className="mt-8 grid grid-cols-3 gap-3">
          {["5 题", "10 题", "15 题"].map((count) => (
            <div className="rounded-2xl bg-white/8 px-3 py-4 text-center" key={count}>
              <dt className="text-lg font-black">{count}</dt>
              <dd className="mt-1 text-[0.7rem] text-paper-100/60">可选题量</dd>
            </div>
          ))}
        </dl>
      </aside>

      <section className="lg:col-span-2" id="principles">
        <h2 className="text-2xl font-black tracking-[-0.02em]">从回答到报告</h2>
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {principles.map(({ label, detail }, index) => (
            <article
              className="rounded-3xl border border-black/10 bg-white/65 p-6 shadow-sm"
              key={label}
            >
              <p className="text-xs font-black text-brand-600">0{index + 1}</p>
              <h3 className="mt-5 text-lg font-black">{label}</h3>
              <p className="mt-3 text-sm leading-7 text-ink-700">{detail}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
