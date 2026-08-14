import type { InputHTMLAttributes, ReactNode } from "react";
import { useId } from "react";

interface FormFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly hint?: ReactNode;
  readonly label: string;
}

export function FormField({ className = "", hint, id, label, ...props }: FormFieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = hint === undefined ? undefined : `${inputId}-hint`;
  return (
    <label className="block" htmlFor={inputId}>
      <span className="text-sm font-bold text-ink-950">{label}</span>
      <input
        aria-describedby={hintId}
        className={[
          "mt-2 min-h-12 w-full rounded-2xl border border-black/15 bg-white px-4 text-base text-ink-950 shadow-sm placeholder:text-ink-700/55 disabled:cursor-not-allowed disabled:bg-paper-100",
          className,
        ].join(" ")}
        id={inputId}
        {...props}
      />
      {hint === undefined ? null : (
        <span className="mt-2 block text-xs leading-5 text-ink-700" id={hintId}>
          {hint}
        </span>
      )}
    </label>
  );
}
