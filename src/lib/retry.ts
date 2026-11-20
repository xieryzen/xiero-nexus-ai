/**
 * Sending a request to a provider again when the answer is "not now".
 *
 * A free tier answers 429 when its few requests a minute are used up and 503
 * when it is busy; a paid one does the same under load. Such an answer means
 * the request was not done, so sending it again is safe, and a wait of some
 * seconds is usually all it takes. Without that, one such answer ends an
 * agent's task, and a project with it.
 *
 * Pure: no network, no environment. The I/O is in ./http-client.ts.
 */
import { limitHint, type LimitHint } from "./provider-limits";

/** Answers that say "not now": rate limited (429), busy (503, and 529 at Anthropic). */
export const RETRY_STATUSES: ReadonlySet<number> = new Set([429, 503, 529]);

/** How often a request is sent again, unless PROVIDER_RETRIES says otherwise. */
export const DEFAULT_PROVIDER_RETRIES = 4;
export const MAX_PROVIDER_RETRIES = 8;

/**
 * A busy provider (503, 529) is asked again this often and no more. A limit
 * (429) ends when its minute does, so waiting for it pays; how long a provider
 * stays busy nobody knows, and the caller's second model is there meanwhile.
 */
export const BUSY_RETRIES = 2;

/**
 * The longest single wait a provider may ask for. When it asks for more, its
 * answer is passed on: the caller's second model is a better use of the time.
 */
export const MAX_RETRY_WAIT_MS = 90_000;

/** All waits of one request together. Enough for a limit counted per minute. */
export const MAX_TOTAL_RETRY_WAIT_MS = 150_000;

/**
 * A model that was still limited after all the waits is not waited for again
 * for this long: its limit is not one that a minute ends (a quota that is used
 * up, a plan without the model), and every request would wait in vain. Longer
 * each time the wait was in vain again, until the model answers.
 */
export const GIVE_UP_FOR_MS: readonly number[] = [5 * 60_000, 15 * 60_000, 60 * 60_000];

/** The waits when the provider does not say how long: about a minute and a half in all. */
const BACKOFF_MS = [3_000, 10_000, 25_000, 45_000];

/** `PROVIDER_RETRIES`: 0 turns it off. Anything that is not a number is the default. */
export function retryLimit(raw: string | undefined | null): number {
  const text = (raw ?? "").trim();
  if (!/^\d+$/.test(text)) return DEFAULT_PROVIDER_RETRIES;
  return Math.min(Number(text), MAX_PROVIDER_RETRIES);
}

/**
 * What a `Retry-After` header asks for, in milliseconds: a number of seconds,
 * or a date. Nothing when there is no header or it cannot be read.
 */
export function retryAfterMs(header: string | null | undefined, now: number = Date.now()): number | null {
  const text = (header ?? "").trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/**
 * How long to wait before attempt `attempt + 1` (0 for the first time the
 * request is sent again). Nothing when the provider asks for more than
 * MAX_RETRY_WAIT_MS: then the answer is passed on as it is.
 *
 * `inBody`: the wait the answer names in its body (provider-limits.ts), for a
 * provider that says it there and not in a header. The header goes first.
 */
export function retryDelayMs(
  header: string | null | undefined,
  attempt: number,
  now: number = Date.now(),
  inBody: number | null = null,
): number | null {
  const asked = retryAfterMs(header, now) ?? inBody;
  if (asked === null) return BACKOFF_MS[Math.min(Math.max(attempt, 0), BACKOFF_MS.length - 1)]!;
  if (asked > MAX_RETRY_WAIT_MS) return null;
  // A little more than asked: a limit that is counted per second is still full at the exact moment.
  return Math.max(1_000, asked) + 250;
}

/** Wait, unless the caller gives up first. */
export function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      const err = new Error("The request was cancelled");
      err.name = "AbortError";
      return err;
    };
    if (signal?.aborted) return reject(aborted());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(aborted());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * What a request is counted under: the address without its query, and the
 * model where the body names one, since a limit is usually a model's.
 */
export function retryKey(url: string, body?: string | null): string {
  let where = url;
  try {
    const parsed = new URL(url);
    where = parsed.origin + parsed.pathname;
  } catch {
    /* not an address: the text itself will do */
  }
  const model = body ? /"model"\s*:\s*"([^"\\]{1,200})"/.exec(body.slice(0, 4000))?.[1] : undefined;
  return model ? `${where} ${model}` : where;
}

/**
 * Remembers which models were waited for in vain, so that the next request
 * does not wait again. A request is still sent while a model is given up, and
 * the first answer ends it: a limit that many requests ran into at the same
 * moment is forgotten by the next one that gets through.
 */
export class Patience {
  private readonly given = new Map<string, { until: number; times: number }>();

  /** May a request under this key wait? Not while the key is given up. */
  has(key: string, now: number): boolean {
    const given = this.given.get(key);
    return !given || now >= given.until;
  }

  /** All the waits were taken and the answer was still "not now". */
  spent(key: string, now: number): void {
    const times = (this.given.get(key)?.times ?? 0) + 1;
    if (this.given.size >= 500 && !this.given.has(key)) {
      for (const [k, given] of this.given) if (given.until <= now) this.given.delete(k);
      if (this.given.size >= 500) this.given.clear();
    }
    const length = GIVE_UP_FOR_MS[Math.min(times, GIVE_UP_FOR_MS.length) - 1]!;
    this.given.set(key, { until: now + length, times });
  }

  /** The model answered: it is waited for again. */
  answered(key: string): void {
    this.given.delete(key);
  }
}

/** The most of a "not now" answer that is read to see what it says about the wait. */
const HINT_MAX_BYTES = 64 * 1024;
/** How long reading it may take: an answer that says "not now" is a few lines. */
const HINT_MAX_MS = 5_000;

/**
 * Read the body of a "not now" answer, to see what it says about the wait.
 * Null when it is not a short text (a stream, or longer than an error is):
 * the answer is then left as it is. What was read is in `text`, also when the
 * reading was cut short.
 */
async function readNotNow(res: Response): Promise<string | null> {
  const length = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(length) && length > HINT_MAX_BYTES) return null;
  if (/event-stream/i.test(res.headers.get("content-type") ?? "")) return null;
  if (!res.body || res.bodyUsed) return null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), HINT_MAX_MS);
  });
  try {
    for (;;) {
      const part = await Promise.race([reader.read(), late]);
      if (part === "late") {
        void reader.cancel().catch(() => undefined);
        break;
      }
      if (part.done) break;
      bytes += part.value.byteLength;
      text += decoder.decode(part.value, { stream: true });
      if (bytes > HINT_MAX_BYTES) {
        void reader.cancel().catch(() => undefined);
        break;
      }
    }
  } catch {
    /* what was read so far is all there is */
  } finally {
    if (timer) clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      /* still reading: the answer is given up anyway */
    }
  }
  return text + decoder.decode();
}

/** The same answer with its body to read once more, for the caller. */
function withBody(res: Response, text: string): Response {
  const headers = new Headers(res.headers);
  // The text is what was read: it is no longer packed, nor of that length.
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(text, { status: res.status, statusText: res.statusText, headers });
}

export interface RetryOptions {
  /** How often the request may be sent again. 0: once and no more. */
  limit: number;
  /** What the request is counted under (see retryKey), and where that is remembered. Both or neither. */
  key?: string;
  patience?: Patience;
  /** The caller's own signal: a wait ends when it does. */
  signal?: AbortSignal | null;
  /** For tests: in place of the clock. */
  sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  now?: () => number;
}

/**
 * Send a request, and send it again while the answer is "not now". Returns
 * the first answer that is something else, or the last "not now" when the
 * limit, the provider's own wait or the time allowed for waiting is used up.
 * A busy provider is asked again BUSY_RETRIES times at most. With a key and
 * a Patience, a model that used up all its waits is not waited for again for
 * a while (GIVE_UP_FOR_MS), or until it answers.
 * The answers that are given up are closed, so their connections are free.
 *
 * Where the answer's header names no wait, its body is read for one, and for
 * a limit that no wait of minutes ends (provider-limits.ts): Google says both
 * there. Such a limit is passed on at once. The caller gets the answer with
 * its body as it was.
 */
export async function fetchWithRetries(
  once: () => Promise<Response>,
  opts: RetryOptions,
): Promise<Response> {
  const wait = opts.sleep ?? sleep;
  const now = opts.now ?? Date.now;
  const memory = opts.key !== undefined && opts.patience ? { key: opts.key, patience: opts.patience } : null;
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    const res = await once();
    if (!RETRY_STATUSES.has(res.status)) {
      if (res.ok) memory?.patience.answered(memory.key);
      return res;
    }
    if (opts.limit <= 0) return res;
    if (memory && !memory.patience.has(memory.key, now())) return res;
    const header = res.headers.get("retry-after");
    // What is passed on when this answer is the last: the answer itself, or,
    // once its body was read here, the same answer with that body.
    let answer = res;
    let hint: LimitHint | null = null;
    if (retryAfterMs(header, now()) === null) {
      const text = await readNotNow(res);
      if (text !== null) {
        hint = limitHint(text);
        answer = withBody(res, text);
      }
    }
    // A quota for the day, or no allowance at all: no wait of minutes ends it.
    if (hint?.lasting) return answer;
    const delay = retryDelayMs(header, attempt, now(), hint?.waitMs ?? null);
    if (delay === null) return answer;
    if (
      attempt >= (res.status === 429 ? opts.limit : Math.min(opts.limit, BUSY_RETRIES)) ||
      waited + delay > MAX_TOTAL_RETRY_WAIT_MS
    ) {
      // Waited for, and still "not now".
      if (attempt > 0) memory?.patience.spent(memory.key, now());
      return answer;
    }
    void res.body?.cancel().catch(() => undefined);
    await wait(delay, opts.signal);
    waited += delay;
  }
}
