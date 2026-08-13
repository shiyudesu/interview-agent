import * as Slot from "radix-ui/slot";
import type { ButtonHTMLAttributes } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly asChild?: boolean;
  readonly tone?: "primary" | "secondary";
};

export function Button({
  asChild = false,
  className = "",
  tone = "primary",
  type = "button",
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot.Root : "button";
  return (
    <Component
      className={[
        "inline-flex min-h-11 items-center justify-center rounded-full px-5 py-2.5 text-sm font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-55",
        tone === "primary"
          ? "bg-brand-600 text-white shadow-sm hover:bg-brand-700"
          : "border border-black/15 bg-white/70 text-ink-950 hover:bg-white",
        className,
      ].join(" ")}
      type={asChild ? undefined : type}
      {...props}
    />
  );
}
