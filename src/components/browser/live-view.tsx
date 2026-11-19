"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, ApiError } from "@/lib/client";
import type { LiveDTO } from "@/lib/browser/sessions";
import { DateTime } from "@/components/time";
import { Alert, Button, Card, Input, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icons";

const message = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/** Keys that are passed on to the page as they are pressed. */
const PASSED_KEYS = new Set(["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "PageDown", "PageUp", "Home", "End", " "]);

type Outcome = "continue" | "give_up" | "save" | "discard";

const DONE: Record<Outcome, string> = {
  continue: "The page is handed back: the agent goes on from where you left it.",
  give_up: "The agent is told that this cannot be done now.",
  save: "The session is kept with the account: the next run is let in without signing in again.",
  discard: "The page was closed, and nothing was kept.",
};

/**
 * A page of the browser that waits for a person. It is shown as a picture
 * that is taken again every second; a click on the picture is a click on
 * the page, and what is typed here is typed there.
 */
export function LiveView({ id, initial }: { id: string; initial: LiveDTO | null }) {
  const [live, setLive] = useState(initial);
  const [gone, setGone] = useState(initial === null);
  const [done, setDone] = useState<Outcome | null>(null);
  const [picture, setPicture] = useState<string | null>(null);
  const [pageUrl, setPageUrl] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [settling, setSettling] = useState(false);
  const loading = useRef(false);
  const shown = useRef<string | null>(null);
  const stopped = useRef(initial === null);
  const back = live?.projectId ? `/dashboard/projects/${live.projectId}` : "/dashboard/browser";

  const refresh = useCallback(async () => {
    if (loading.current || stopped.current) return;
    loading.current = true;
    try {
      // A picture that does not come is not waited for: the next round asks again.
      const res = await fetch(`/api/browser/live/${id}/screen`, { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(12_000) });
      if (res.status === 404) {
        stopped.current = true;
        setGone(true);
        return;
      }
      if (!res.ok) return;
      const url = decodeURI(res.headers.get("x-page-url") ?? "");
      const next = URL.createObjectURL(await res.blob());
      if (shown.current) URL.revokeObjectURL(shown.current);
      shown.current = next;
      setPicture(next);
      setPageUrl(url);
    } catch {
      // The next round asks again.
    } finally {
      loading.current = false;
    }
  }, [id]);

  // The picture, every second while this page is in front; what the page waits for, every few.
  useEffect(() => {
    void refresh();
    const pictures = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 1_000);
    const states = setInterval(async () => {
      if (stopped.current) return;
      try {
        const res = await apiFetch<{ live: LiveDTO }>(`/api/browser/live/${id}`);
        setLive(res.live);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          stopped.current = true;
          setGone(true);
        }
      }
    }, 2_500);
    return () => {
      clearInterval(pictures);
      clearInterval(states);
      if (shown.current) URL.revokeObjectURL(shown.current);
    };
  }, [id, refresh]);

  // What a person does is passed on one thing after the other, in the order
  // it was done: keys that are typed quickly must not overtake each other.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const queued = useRef(0);
  const send = useCallback(
    (input: Record<string, unknown>) => {
      if (stopped.current || queued.current > 200) return;
      queued.current++;
      queue.current = queue.current.then(async () => {
        try {
          if (stopped.current) return;
          setError(null);
          await apiFetch(`/api/browser/live/${id}/input`, { method: "POST", body: JSON.stringify(input) });
          // What the page made of it: at once, and again when it has had a moment.
          void refresh();
          setTimeout(() => void refresh(), 600);
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) {
            stopped.current = true;
            setGone(true);
          } else {
            setError(message(err, "That could not be passed on to the page."));
          }
        } finally {
          queued.current--;
        }
      });
    },
    [id, refresh],
  );

  function point(e: React.MouseEvent<HTMLImageElement> | React.WheelEvent<HTMLImageElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const width = live?.width ?? 1280;
    const height = live?.height ?? 800;
    return { x: Math.round(((e.clientX - rect.left) / rect.width) * width), y: Math.round(((e.clientY - rect.top) / rect.height) * height) };
  }

  function onKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const printable = [...e.key].length === 1;
    if (!printable && !PASSED_KEYS.has(e.key)) return;
    e.preventDefault();
    send({ type: "key", key: e.key, code: e.code.slice(0, 20), shift: e.shiftKey });
  }

  async function settle(outcome: Outcome) {
    if (outcome === "give_up" && !confirm("Tell the agent that this cannot be done now? It finishes its task with what it has.")) return;
    if (outcome === "discard" && !confirm("Close the page without keeping the session?")) return;
    setSettling(true);
    setError(null);
    try {
      await apiFetch(`/api/browser/live/${id}`, { method: "POST", body: JSON.stringify({ outcome }) });
      stopped.current = true;
      setDone(outcome);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        stopped.current = true;
        setGone(true);
      } else {
        setError(message(err, "That did not work."));
      }
    } finally {
      setSettling(false);
    }
  }

  // Where one goes from here is loaded anew, not shown as it was before: the
  // project has moved on in the meantime, and the account has a session now.
  const leave = (to: string) => window.location.assign(to);

  if (done) {
    const toProject = (done === "continue" || done === "give_up") && Boolean(live?.projectId);
    return (
      <div className="space-y-6">
        <PageHeader title="A page in the browser" />
        <Alert tone="ok">{DONE[done]}</Alert>
        <Button onClick={() => leave(toProject ? back : "/dashboard/browser")}>{toProject ? "Back to the project" : "Back to the Browser page"}</Button>
      </div>
    );
  }

  if (gone || !live) {
    return (
      <div className="space-y-6">
        <PageHeader title="A page in the browser" />
        <Alert tone="warn">This page does not wait any more: it was handed back, its time was up, or its run has ended.</Alert>
        <Button variant="ghost" onClick={() => leave("/dashboard/browser")}>Back to the Browser page</Button>
      </div>
    );
  }

  const owner = live.kind === "owner";
  return (
    <div className="space-y-4" data-testid="live-view">
      <PageHeader
        title={owner ? `Sign in to ${live.site} by hand` : "A page waits for you"}
        description={owner ? "Do what the site asks of a person, then keep the session: agents are let in with it." : "Do what the page asks of a person, then hand it back: the agent goes on from where you leave it."}
        actions={
          owner ? (
            <>
              <Button variant="ghost" loading={settling} onClick={() => void settle("discard")}>Close without keeping</Button>
              <Button loading={settling} disabled={live.busy} onClick={() => void settle("save")}><Icon name="check" size={16} /> Keep the session</Button>
            </>
          ) : (
            <>
              <Button variant="ghost" loading={settling} onClick={() => void settle("give_up")}>It cannot be done</Button>
              <Button loading={settling} onClick={() => void settle("continue")}><Icon name="check" size={16} /> Hand back to the agent</Button>
            </>
          )
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}

      <Card>
        <div className="space-y-1 text-sm" data-testid="live-reason">
          <p className="text-ink">{live.reason}</p>
          {live.note && <p className="text-ink-2">{live.note}</p>}
          <p className="text-xs text-ink-3">
            {owner
              ? `Account ${live.account ?? ""}`
              : [live.projectTitle, live.taskTitle, live.agentName ? `by ${live.agentName}` : "", live.account ? `account ${live.account}` : ""].filter(Boolean).join(" · ")}
            {" · "}
            {owner ? "closes when nothing is done until " : "waits until "}
            <DateTime at={live.deadline} />
          </p>
        </div>
      </Card>

      <section className="card overflow-hidden">
        <header className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
          <Button variant="ghost" onClick={() => send({ type: "back" })} disabled={live.busy} aria-label="Back one page">Back</Button>
          <Button variant="ghost" onClick={() => send({ type: "reload" })} disabled={live.busy} aria-label="Load the page again"><Icon name="refresh" size={16} /></Button>
          <p className="mono min-w-0 flex-1 truncate text-xs text-ink-3" data-testid="live-url">{pageUrl || "…"}</p>
        </header>
        <div
          className="relative bg-black/40 outline-none focus:ring-2 focus:ring-signal/60"
          tabIndex={0}
          onKeyDown={onKey}
          role="application"
          aria-label="The page in the browser. Click it to act on it; what you type here is typed there."
        >
          {picture ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={picture}
              alt="The page as the browser shows it"
              data-testid="live-screen"
              className="block h-auto w-full cursor-pointer select-none"
              draggable={false}
              onClick={(e) => {
                e.currentTarget.parentElement?.focus();
                if (!live.busy) send({ type: "click", ...point(e) });
              }}
              onDoubleClick={(e) => {
                if (!live.busy) send({ type: "click", ...point(e), double: true });
              }}
              onWheel={(e) => {
                if (!live.busy && Math.abs(e.deltaY) >= 20) send({ type: "scroll", ...point(e), dy: e.deltaY });
              }}
            />
          ) : (
            <p className="px-5 py-16 text-center text-sm text-ink-3">The page is being shown…</p>
          )}
          {live.busy && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-sm text-ink">The app is filling in the form…</div>
          )}
        </div>
        <footer className="space-y-2 border-t border-line px-3 py-3">
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!text) return;
              send({ type: "text", text });
              setText("");
            }}
          >
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Type here what goes into the field that has the cursor"
              className="min-w-0 flex-1"
              maxLength={2000}
              autoComplete="off"
              data-testid="live-text"
              disabled={live.busy}
            />
            <Button type="submit" variant="ghost" disabled={live.busy || !text}>Type it</Button>
            <Button type="button" variant="ghost" disabled={live.busy} onClick={() => send({ type: "key", key: "Enter", code: "Enter" })}>Enter</Button>
            <Button type="button" variant="ghost" disabled={live.busy} onClick={() => send({ type: "key", key: "Tab", code: "Tab" })}>Tab</Button>
          </form>
          <p className="text-xs text-ink-3">
            Click on the picture to click on the page; with the picture chosen, what you type on your keyboard is typed there. It is taken again every second.
            What you type is not written down.
          </p>
        </footer>
      </section>
    </div>
  );
}
