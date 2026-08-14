import { Link, useParams } from "react-router-dom";

import { Button } from "../components/button.js";

export function InterviewPlaceholderPage() {
  const { interviewId } = useParams();
  return (
    <section className="mx-auto max-w-3xl rounded-[2rem] border border-black/10 bg-white/75 p-8 shadow-sm">
      <p className="text-xs font-black tracking-[0.18em] text-brand-700">INTERVIEW</p>
      <h2 className="mt-4 text-3xl font-black">面试已准备恢复</h2>
      <p className="mt-4 text-sm leading-7 text-ink-700">
        面试标识：{interviewId}。完整作答界面将在下一项任务接入。
      </p>
      <Button asChild className="mt-7" tone="secondary">
        <Link to="/app">返回面试空间</Link>
      </Button>
    </section>
  );
}
