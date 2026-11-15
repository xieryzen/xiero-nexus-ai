"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { cn } from "@/components/ui";
import { apiFetch } from "@/lib/client";
import { RelativeTime } from "@/components/time";
import type { NotificationDTO } from "@/lib/notifications";

const POLL_MS = 30_000;

const LEVEL_DOT: Record<NotificationDTO["level"], string> = {
  info: "bg-info",
  success: "bg-ok",
  warning: "bg-warn",
  error: "bg-danger",
};

/**
 * The bell in the top bar: what happened while nobody was watching (a run
 * finished, a video is ready, a schedule could not start).
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationDTO[]>([]);
  const [unread, setUnread] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ notifications: NotificationDTO[]; unread: number }>("/api/notifications");
      setItems(data.notifications);
      setUnread(data.unread);
      setLoaded(true);
    } catch {
      /* signed out, or the server is restarting: the next round tries again */
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  // Close on a click elsewhere and on Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function markRead(id?: string) {
    setItems((list) => list.map((n) => (!id || n.id === id ? { ...n, read: true } : n)));
    setUnread((n) => (id ? Math.max(0, n - 1) : 0));
    try {
      const data = await apiFetch<{ unread: number }>("/api/notifications/read", {
        method: "POST",
        body: JSON.stringify(id ? { id } : {}),
      });
      setUnread(data.unread);
    } catch {
      void load();
    }
  }

  async function clearAll() {
    setItems([]);
    setUnread(0);
    try {
      await apiFetch("/api/notifications", { method: "DELETE" });
    } catch {
      void load();
    }
  }

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        className="btn-ghost relative p-2"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        aria-haspopup="true"
        title="Notifications"
        onClick={() => {
          setOpen((v) => !v);
          if (!open) void load();
        }}
      >
        <Icon name="bell" />
        {unread > 0 && (
          <span
            className="absolute right-0.5 top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-signal px-1 text-[10px] font-semibold leading-none text-canvas"
            data-testid="unread-count"
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full z-40 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-line bg-surface shadow-xl animate-fade-in"
          role="dialog"
          aria-label="Notifications"
        >
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
            <p className="text-sm font-semibold text-ink">Notifications</p>
            <div className="flex items-center gap-3 text-xs">
              {unread > 0 && (
                <button type="button" className="text-signal hover:underline" onClick={() => void markRead()}>
                  Mark all read
                </button>
              )}
              {items.length > 0 && (
                <button type="button" className="text-ink-3 hover:text-ink" onClick={() => void clearAll()}>
                  Clear
                </button>
              )}
            </div>
          </div>
          <ul className="max-h-[60vh] divide-y divide-line overflow-y-auto">
            {items.length === 0 && (
              <li className="px-4 py-8 text-center text-sm text-ink-3">
                {loaded ? "Nothing yet. Finished runs and videos show up here." : "Loading…"}
              </li>
            )}
            {items.map((n) => {
              const body = (
                <div className="flex gap-3 px-4 py-3">
                  <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", LEVEL_DOT[n.level], n.read && "opacity-30")} />
                  <div className="min-w-0 flex-1">
                    <p className={cn("text-sm", n.read ? "text-ink-2" : "font-medium text-ink")}>{n.title}</p>
                    {n.body && <p className="mt-0.5 line-clamp-3 whitespace-pre-line text-xs text-ink-3">{n.body}</p>}
                    <p className="mt-1 text-[11px] text-ink-3"><RelativeTime at={n.createdAt} /></p>
                  </div>
                </div>
              );
              return (
                <li key={n.id} className="hover:bg-surface-2/60">
                  {n.link ? (
                    <Link
                      href={n.link}
                      className="block"
                      onClick={() => {
                        setOpen(false);
                        if (!n.read) void markRead(n.id);
                      }}
                    >
                      {body}
                    </Link>
                  ) : (
                    <button type="button" className="block w-full text-left" onClick={() => !n.read && void markRead(n.id)}>
                      {body}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="border-t border-line px-4 py-2.5 text-xs text-ink-3">
            Also send these to a webhook:{" "}
            <Link href="/dashboard/settings" className="text-signal hover:underline" onClick={() => setOpen(false)}>
              Settings
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
