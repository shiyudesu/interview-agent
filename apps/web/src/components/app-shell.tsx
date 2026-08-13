import * as Separator from "radix-ui/separator";
import * as VisuallyHidden from "radix-ui/visually-hidden";
import { NavLink, Outlet } from "react-router-dom";

const navigation = [
  { to: "/", label: "首页", end: true },
  { to: "/app", label: "面试空间", end: false },
] as const;

export function AppShell() {
  return (
    <div className="min-h-screen">
      <a
        className="sr-only z-50 rounded-md bg-white px-4 py-2 text-sm font-semibold shadow focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
        href="#main-content"
      >
        跳到主要内容
      </a>
      <header className="border-b border-black/10 bg-paper-50/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4 sm:px-8">
          <NavLink className="group flex items-center gap-3" to="/">
            <span
              aria-hidden="true"
              className="grid size-10 place-items-center rounded-2xl bg-ink-950 text-sm font-black text-paper-50 shadow-sm transition-transform group-hover:-rotate-3"
            >
              GO
            </span>
            <span>
              <span className="block text-sm font-black tracking-[0.16em] text-ink-950">
                INTERVIEW LAB
              </span>
              <span className="block text-xs text-ink-700">Go 后端模拟面试</span>
            </span>
          </NavLink>

          <nav aria-label="主要导航" className="flex items-center gap-1">
            {navigation.map(({ to, label, end }) => (
              <NavLink
                className={({ isActive }) =>
                  [
                    "rounded-full px-3 py-2 text-sm font-semibold transition-colors",
                    isActive
                      ? "bg-ink-950 text-paper-50"
                      : "text-ink-700 hover:bg-paper-100 hover:text-ink-950",
                  ].join(" ")
                }
                end={end}
                key={to}
                to={to}
              >
                {label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-5 py-10 sm:px-8 sm:py-16" id="main-content">
        <VisuallyHidden.Root>
          <h1>Go 后端模拟面试</h1>
        </VisuallyHidden.Root>
        <Outlet />
      </main>

      <footer className="mx-auto max-w-6xl px-5 pb-8 sm:px-8">
        <Separator.Root className="mb-6 h-px bg-black/10" decorative />
        <p className="text-xs leading-6 text-ink-700">
          文字面试内容会保存为可恢复的会话，最终结果以不可变报告呈现。
        </p>
      </footer>
    </div>
  );
}
