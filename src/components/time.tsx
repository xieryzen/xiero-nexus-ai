"use client";

import { Fragment, useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { formatDateTime, formatRelative } from "@/lib/format";

/**
 * Times on a page that the server renders first.
 *
 * The server knows the moment, but not the reader's time zone or clock, and
 * its "3m ago" is a little older than the browser's. Text that differs between
 * the two makes React report an error and render the whole page again. These
 * components say that the difference is expected, and put the browser's own
 * text in place as soon as the page is live.
 */

const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

// One timer for every relative time on the page, running only while one is shown.
const watchers = new Set<() => void>();
let ticks = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function watch(onTick: () => void): () => void {
  watchers.add(onTick);
  timer ??= setInterval(() => {
    ticks++;
    for (const notify of watchers) notify();
  }, 30_000);
  return () => {
    watchers.delete(onTick);
    if (watchers.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}
const never = () => () => undefined;
const currentTick = () => ticks;
const firstTick = () => 0;

type Moment = number | string | Date;

function Stamp({
  at,
  text,
  live,
  hint,
  className,
}: {
  at: Moment;
  text: (date: Date) => string;
  /** Whether the text changes as time passes. */
  live: boolean;
  /** Whether to show the full date and time on hover. */
  hint: boolean;
  className?: string;
}) {
  const [mounted, setMounted] = useState(false);
  useBrowserLayoutEffect(() => setMounted(true), []);
  useSyncExternalStore(live ? watch : never, currentTick, firstTick);

  const date = new Date(at);
  const valid = !Number.isNaN(date.getTime());
  if (!valid) return null;
  return (
    <time
      // A new element once the page is live: whatever the server wrote, the
      // reader then sees what their own browser makes of the moment.
      key={mounted ? "browser" : "server"}
      dateTime={date.toISOString()}
      title={hint && mounted ? formatDateTime(date) : undefined}
      className={className}
      suppressHydrationWarning
    >
      {text(date)}
    </time>
  );
}

/** "just now", "5m ago", "3d ago", kept up to date while the page is open. */
export function RelativeTime({ at, className }: { at: Moment; className?: string }) {
  return <Stamp at={at} text={formatRelative} live hint className={className} />;
}

/** A date and time in the reader's own time zone. */
export function DateTime({ at, className }: { at: Moment; className?: string }) {
  return <Stamp at={at} text={formatDateTime} live={false} hint={false} className={className} />;
}

/** A moment written by `text`, for anything the two above do not cover. */
export function TimeText({ at, text, className }: { at: Moment; text: (date: Date) => string; className?: string }) {
  return <Stamp at={at} text={text} live={false} hint={false} className={className} />;
}

/** The parts of a line of details that exist, with a dot between them. */
export function Dotted({ parts }: { parts: ReactNode[] }) {
  const shown = parts.filter((part) => part !== null && part !== undefined && part !== false && part !== "");
  return (
    <>
      {shown.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && " · "}
          {part}
        </Fragment>
      ))}
    </>
  );
}
