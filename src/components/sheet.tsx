"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/icons";
import { cn } from "@/components/ui";

/**
 * What comes up over the page to choose from or to fill in. On a phone it is
 * a sheet from the bottom edge, as wide as the screen; on a wider screen a
 * box in the middle. `dialog` is a small box in the middle on both (a name
 * to type, a question to answer). Escape, the cross and a click beside it
 * close it; with `onBack` the cross is an arrow back to the sheet before.
 */
export function Sheet({
  open,
  onClose,
  onBack,
  title,
  children,
  dialog = false,
  testId,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  onBack?: () => void;
  title: string;
  children: ReactNode;
  dialog?: boolean;
  testId?: string;
  wide?: boolean;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // The page under it does not scroll.
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = before;
    };
  }, [open, onClose]);
  if (!open || !mounted) return null;

  return createPortal(
    <div className={cn("fixed inset-0 z-[60] flex justify-center", dialog ? "items-center p-5" : "items-end sm:items-center sm:p-6")}>
      <div className="absolute inset-0 animate-fade bg-black/55" onClick={onClose} aria-hidden="true" />
      {dialog ? (
        <div role="dialog" aria-modal="true" aria-label={title} data-testid={testId} className="relative w-full max-w-sm animate-fade-in rounded-[24px] border border-line bg-surface p-5 shadow-pop">
          <h2 className="mb-3 text-lg font-semibold text-ink">{title}</h2>
          {children}
        </div>
      ) : (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={title}
          data-testid={testId}
          className={cn(
            "relative flex max-h-[88dvh] w-full animate-sheet-up flex-col overflow-hidden rounded-t-[28px] bg-canvas shadow-pop sm:animate-fade-in sm:rounded-[28px] sm:border sm:border-line",
            wide ? "sm:max-w-xl" : "sm:max-w-md",
          )}
        >
          <div className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-ink/25 sm:hidden" aria-hidden="true" />
          <div className="flex shrink-0 items-center gap-1 px-2.5 pb-1.5 pt-2 sm:pt-3">
            <button type="button" className="icon-btn text-ink" onClick={onBack ?? onClose} aria-label={onBack ? "Back" : "Close"}>
              <Icon name={onBack ? "back" : "x"} size={22} />
            </button>
            <h2 className="min-w-0 flex-1 truncate text-center text-[17px] font-semibold text-ink">{title}</h2>
            <span className="w-10 shrink-0" aria-hidden="true" />
          </div>
          <div className="pb-safe min-h-0 flex-1 overflow-y-auto px-4 pt-1.5">{children}</div>
        </div>
      )}
    </div>,
    document.body,
  );
}

/**
 * What a page puts into the bar at the top, in the place the shell keeps for
 * it (app-shell.tsx): the name of a conversation with its menu.
 */
export function ShellTitle({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById("shell-title")), []);
  return slot ? createPortal(children, slot) : null;
}
