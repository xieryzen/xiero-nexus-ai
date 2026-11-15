import { randomUUID } from "node:crypto";

/**
 * State that has to be one per server process.
 *
 * Module-level variables are not enough for that: the server is built in
 * several bundles (route handlers, the instrumentation hook that starts the
 * background worker), and a module can be loaded once in each, with its own
 * variables. Everything that the worker and the request handlers share lives
 * here, on `globalThis`, so both see the same thing.
 *
 * No imports from the rest of the app: anything may import this.
 */

export interface RunChannel<E = unknown> {
  /** Pages following the project's run. */
  listeners: Set<(event: E) => void>;
}

export interface WorkerState {
  started: boolean;
  ticking: boolean;
  timer: ReturnType<typeof setInterval> | null;
  startedAt: number | null;
  lastTickAt: number | null;
  lastError: string | null;
  /** Step name → message of its last failure, cleared when it works again. */
  stepErrors: Record<string, string>;
  /** Jobs being worked on, by id. */
  jobs: Set<string>;
  /** A round was asked for while one was running: do another right after. */
  again: boolean;
  lastHousekeepingAt: number | null;
}

export interface NexusRuntime {
  /** Names this server process in the database (run and job ownership). */
  bootId: string;
  /** Projects whose run was asked to stop. */
  cancelled: Set<string>;
  /** Video refreshes in flight, by asset id. */
  refreshing: Map<string, Promise<unknown>>;
  /** Live events of project runs, by project id. */
  channels: Map<string, RunChannel>;
  /** Runs this process is executing, by run id. */
  activeRuns: Map<string, Promise<void>>;
  worker: WorkerState;
  /** Stopping the server (see shutdown.ts). */
  stop: { listening: boolean; asked: boolean };
  /** Rate-limit buckets (see ratelimit.ts). */
  buckets: Map<string, { count: number; resetAt: number }>;
  /** Free-form caches of small things worth computing once (ffmpeg's version, …). */
  cache: Map<string, { value: unknown; at: number }>;
  /** The end of each queue of work that runs one at a time (see `serial`). */
  queues: Map<string, Promise<unknown>>;
  /** Request-scoped values (see request-context.ts). An AsyncLocalStorage. */
  requestContext: unknown;
}

declare global {
  // eslint-disable-next-line no-var
  var __nexusRuntime: NexusRuntime | undefined;
}

export function runtime(): NexusRuntime {
  globalThis.__nexusRuntime ??= {
    bootId: randomUUID(),
    cancelled: new Set(),
    refreshing: new Map(),
    channels: new Map(),
    activeRuns: new Map(),
    worker: {
      started: false,
      ticking: false,
      timer: null,
      startedAt: null,
      lastTickAt: null,
      lastError: null,
      stepErrors: {},
      jobs: new Set(),
      again: false,
      lastHousekeepingAt: null,
    },
    stop: { listening: false, asked: false },
    buckets: new Map(),
    cache: new Map(),
    queues: new Map(),
    requestContext: null,
  };
  return globalThis.__nexusRuntime;
}

/** A value computed once and kept for `ttlMs`. */
export async function cached<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
  const cache = runtime().cache;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await compute();
  cache.set(key, { value, at: Date.now() });
  return value;
}

/**
 * Run `work` after everything queued earlier under the same key has finished,
 * whether it succeeded or not. For work that must not overlap, such as two
 * ffmpeg runs.
 */
export function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const queues = runtime().queues;
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  const tail = next.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return next;
}
