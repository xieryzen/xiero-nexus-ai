/**
 * What a provider's "not now" says about its limit.
 *
 * A provider that is limited answers 429. Some say in a header how long to
 * wait (`Retry-After`, see ./retry.ts); others say it in the answer itself:
 * Google in a `RetryInfo` detail and in the words "Please retry in 37.2s",
 * OpenAI and its kin in "Please try again in 20s". And some limits are not
 * ones that a wait of a minute ends: a quota that is counted per day, a model
 * the plan has no allowance for, an account without credit. Google names the
 * quota (`quotaId`: …PerDay…), OpenAI says `insufficient_quota`.
 *
 * Pure: it reads a text. Nothing here is sent anywhere.
 */

export interface LimitHint {
  /** The wait the answer names, in milliseconds. Null when it names none. */
  waitMs: number | null;
  /**
   * The limit is not one that waiting some minutes ends: it is counted per
   * day, or there is no allowance at all. Asking again soon is in vain.
   */
  lasting: boolean;
}

/** One quota a Google answer says was exceeded. */
export interface QuotaViolation {
  /** What is counted, without the service's address before it. */
  metric: string;
  /** How it is counted, as far as the quota's id says. */
  window: "day" | "minute" | null;
  /** The allowance, when the answer gives it. */
  limit: number | null;
  model: string | null;
}

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
const WORD_MS: [RegExp, number][] = [
  [/^(?:milliseconds?|msecs?)$/, 1],
  [/^(?:seconds?|secs?)$/, 1000],
  [/^(?:minutes?|mins?)$/, 60_000],
  [/^(?:hours?|hrs?)$/, 3_600_000],
];

/** The longest wait that is taken for one: beyond a week the number is not a wait. */
const LONGEST_MS = 7 * 24 * 3_600_000;

/**
 * A length of time as providers write it: "37.258156337s", "17h18m5.9s",
 * "6m0s", "250ms", "1 seconds", "2 minutes". Null for anything else.
 */
export function durationMs(text: string): number | null {
  const value = text.trim().toLowerCase();
  if (!value || value.length > 40) return null;
  let total: number | null = null;
  if (/^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/.test(value)) {
    total = 0;
    for (const part of value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) total += Number(part[1]) * UNIT_MS[part[2]!]!;
  } else {
    const words = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/.exec(value);
    const unit = words ? WORD_MS.find(([pattern]) => pattern.test(words[2]!)) : undefined;
    if (words && unit) total = Number(words[1]) * unit[1];
  }
  if (total === null || !Number.isFinite(total) || total < 0 || total > LONGEST_MS) return null;
  return Math.round(total);
}

/** The wait a sentence asks for: "Please retry in 37.2s", "try again in 6m0s", "Retry after 1 seconds". */
const ASKED =
  /\b(?:retry|try again)\s+(?:in|after)\s+((?:\d+(?:\.\d+)?(?:ms|s|m|h))+(?![a-z0-9])|\d+(?:\.\d+)?\s*(?:milliseconds?|msecs?|seconds?|secs?|minutes?|mins?|hours?|hrs?)(?![a-z]))/i;

/** The wait that is asked for in words, in milliseconds. Null when the text asks for none. */
export function waitInText(text: string): number | null {
  const found = ASKED.exec(text.slice(0, 8000));
  return found ? durationMs(found[1]!) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `error` object of an answer: { error: {…} }, at times in a list, at times the object itself. */
function errorOf(body: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!isRecord(first)) return null;
  if (isRecord(first.error)) return first.error;
  return first;
}

function detailsOf(error: Record<string, unknown> | null, type: string): Record<string, unknown>[] {
  if (!error || !Array.isArray(error.details)) return [];
  return error.details.filter(
    (detail): detail is Record<string, unknown> =>
      isRecord(detail) && typeof detail["@type"] === "string" && (detail["@type"] as string).endsWith(type),
  );
}

/**
 * The quotas a Google answer names as exceeded (`google.rpc.QuotaFailure`).
 * Empty for any other answer. Where a quota comes without its allowance, the
 * allowance is taken from the message, which lists the same quotas in the
 * same order ("* Quota exceeded for metric: …, limit: 0, model: …").
 */
export function quotaViolations(body: string): QuotaViolation[] {
  const found: QuotaViolation[] = [];
  const error = errorOf(body);
  for (const failure of detailsOf(error, "google.rpc.QuotaFailure")) {
    if (!Array.isArray(failure.violations)) continue;
    for (const violation of failure.violations.slice(0, 12)) {
      if (!isRecord(violation)) continue;
      const id = typeof violation.quotaId === "string" ? violation.quotaId : "";
      const metric = typeof violation.quotaMetric === "string" ? violation.quotaMetric : "";
      const dimensions = isRecord(violation.quotaDimensions) ? violation.quotaDimensions : {};
      const value = Number(violation.quotaValue);
      found.push({
        metric: metric.slice(metric.lastIndexOf("/") + 1),
        window: /PerDay|Daily/i.test(id) ? "day" : /PerMinute/i.test(id) ? "minute" : null,
        limit: violation.quotaValue !== undefined && violation.quotaValue !== null && Number.isFinite(value) ? value : null,
        model: typeof dimensions.model === "string" ? dimensions.model : null,
      });
    }
  }
  if (found.some((violation) => violation.limit === null) && error && typeof error.message === "string") {
    const lines = [...error.message.slice(0, 8000).matchAll(/Quota exceeded for metric: (\S+?), limit: (\d+)(?![\d.])/g)];
    if (lines.length === found.length) {
      found.forEach((violation, i) => {
        const metric = lines[i]![1]!;
        if (violation.limit === null && metric.slice(metric.lastIndexOf("/") + 1) === violation.metric) violation.limit = Number(lines[i]![2]);
      });
    }
  }
  return found;
}

/**
 * What the body of a "not now" answer says about the limit. A body that says
 * nothing gives { waitMs: null, lasting: false }: the limit may end any moment.
 */
export function limitHint(body: string | null | undefined): LimitHint {
  const text = (body ?? "").slice(0, 65_536);
  if (!text.trim()) return { waitMs: null, lasting: false };
  const error = errorOf(text);

  let waitMs: number | null = null;
  for (const info of detailsOf(error, "google.rpc.RetryInfo")) {
    const asked = typeof info.retryDelay === "string" ? durationMs(info.retryDelay) : null;
    if (asked !== null) waitMs = asked;
  }
  const message = error && typeof error.message === "string" ? error.message : text;
  // The words are the more exact of the two ("17h18m5.9s" against "62285s").
  waitMs = waitInText(message) ?? waitMs;

  const violations = quotaViolations(text);
  const lasting =
    violations.some((violation) => violation.window === "day" || violation.limit === 0) ||
    // Google's words for a model the plan gives nothing of.
    /\blimit: 0(?![\d.])/.test(message) ||
    // OpenAI and those that answer like it: the account has no credit.
    [error?.code, error?.type].some((mark) => mark === "insufficient_quota");
  return { waitMs, lasting };
}

/** A wait in words for a person: "45 seconds", "12 minutes", "17 hours and 18 minutes". */
export function waitWords(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const h = `${hours} ${hours === 1 ? "hour" : "hours"}`;
  return rest === 0 ? h : `${h} and ${rest} ${rest === 1 ? "minute" : "minutes"}`;
}
