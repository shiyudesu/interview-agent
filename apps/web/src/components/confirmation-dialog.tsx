import * as AlertDialog from "radix-ui/alert-dialog";
import type { ReactNode } from "react";
import { useState } from "react";

import { Button } from "./button.js";

export interface ConfirmationDialogProps {
  readonly confirmLabel: string;
  readonly description: string;
  readonly disabled?: boolean;
  readonly error?: string;
  readonly onConfirm: () => void;
  readonly title: string;
  readonly trigger: ReactNode;
}

export function ConfirmationDialog({
  confirmLabel,
  description,
  disabled = false,
  error,
  onConfirm,
  title,
  trigger,
}: ConfirmationDialogProps) {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog.Root
      onOpenChange={(nextOpen) => {
        if (!disabled) {
          setOpen(nextOpen);
        }
      }}
      open={open}
    >
      <AlertDialog.Trigger asChild>{trigger}</AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/45 backdrop-blur-sm" />
        <AlertDialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-[min(32rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-[2rem] bg-paper-50 p-7 shadow-2xl"
          onEscapeKeyDown={(event) => {
            if (disabled) {
              event.preventDefault();
            }
          }}
        >
          <AlertDialog.Title className="text-2xl font-black text-ink-950">
            {title}
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-4 text-sm leading-7 text-ink-700">
            {description}
          </AlertDialog.Description>
          {error === undefined ? null : (
            <p className="mt-4 text-sm text-brand-700" role="alert">
              {error}
            </p>
          )}
          <div className="mt-7 flex justify-end gap-3">
            <AlertDialog.Cancel asChild>
              <Button disabled={disabled} tone="secondary">
                取消
              </Button>
            </AlertDialog.Cancel>
            <Button disabled={disabled} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
