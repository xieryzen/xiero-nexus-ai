/**
 * When a model is checked, and what a check's result means. Pure.
 *
 * A model that failed its last check is "failing": it is left out of the
 * model lists and of the automatic choice of a model, until a check passes
 * again. A model that was never checked is offered: the first check comes
 * soon after it was added, and decides.
 *
 * Real work counts as well (v1.10). A model that answers a request is known
 * to work, without a check. One that does not answer for something its
 * provider did rests: the app does not choose it again for a while, as long
 * as the provider says or a minute, doubled each time. Three such requests in
 * a row put it away as a failed check does, and so does one answer that will
 * not change by asking again: no such model, no access, no credit, a quota
 * that is used up for the day.
 */

/** How often a model that works is checked again, when nothing else is set. */
export const HEALTH_INTERVAL_DEFAULT_MINUTES = 360;
const HEALTH_INTERVAL_MIN_MINUTES = 5;
const HEALTH_INTERVAL_MAX_MINUTES = 7 * 24 * 60;
/** A failing model is asked again after this long, then after twice as long each time. */
export const HEALTH_RETRY_FIRST_MS = 15 * 60_000;
/** How long one check waits for an answer. A model that needs longer for one word is of no use. */
export const HEALTH_CHECK_TIMEOUT_MS = 60_000;

export interface CheckedModel {
  lastTestedAt: Date | number | null;
  lastTestStatus: "ok" | "error" | null;
  checkFailures: number;
  /** Requests of real work that failed in a row. */
  useFailures?: number;
  /** Not chosen by the app, and not asked by the check, before this time. */
  retryAt?: Date | number | null;
}

const millis = (time: Date | number): number => (typeof time === "number" ? time : time.getTime());

/**
 * The time between two checks of a working model, in milliseconds, from
 * MODEL_HEALTH_INTERVAL_MINUTES. 0 means that models are not checked
 * automatically ("0", "off", "false", "no").
 */
export function healthIntervalMs(setting: string | undefined | null): number {
  const text = (setting ?? "").trim().toLowerCase();
  if (text === "") return HEALTH_INTERVAL_DEFAULT_MINUTES * 60_000;
  if (["0", "off", "false", "no"].includes(text)) return 0;
  const minutes = Number(text);
  if (!Number.isFinite(minutes) || minutes < 0) return HEALTH_INTERVAL_DEFAULT_MINUTES * 60_000;
  return Math.min(HEALTH_INTERVAL_MAX_MINUTES, Math.max(HEALTH_INTERVAL_MIN_MINUTES, Math.round(minutes))) * 60_000;
}

/** A model that failed its last check: not offered until a check passes. */
export function isFailing(model: Pick<CheckedModel, "lastTestStatus">): boolean {
  return model.lastTestStatus === "error";
}

/**
 * Why a check failed, as far as it matters for asking again. "refused": the
 * provider said no to this request (no credit, no access, no such model), and
 * will say so again in a minute. "temporary": limited, busy, broken or out of
 * reach, which can be over a moment later.
 */
export function failureKind(error: { code?: string; message: string }): "refused" | "temporary" {
  if (error.code === "timeout" || error.code === "network_error") return "temporary";
  const status = Number(/^Provider responded (\d{3})\b/.exec(error.message)?.[1] ?? 0);
  if (status === 408 || status === 425 || status === 429 || status >= 500) return "temporary";
  if (status > 0) return "refused";
  // Without a status the provider was not asked (no key is stored), or did not answer as one.
  return error.code === "bad_request" ? "refused" : "temporary";
}

/** How long after a failed check the model is asked again: 15 minutes, doubled with each failure, never more than the interval. */
export function retryDelayMs(checkFailures: number, intervalMs: number): number {
  const doubled = HEALTH_RETRY_FIRST_MS * 2 ** Math.min(Math.max(checkFailures, 1) - 1, 16);
  return Math.min(doubled, Math.max(intervalMs, HEALTH_RETRY_FIRST_MS));
}

/** When the model is to be checked next, as a time in milliseconds. 0: now. */
export function nextCheckAt(model: CheckedModel, intervalMs: number): number {
  if (model.lastTestedAt === null) return 0;
  const tested = millis(model.lastTestedAt);
  const retryAt = model.retryAt === null || model.retryAt === undefined ? 0 : millis(model.retryAt);
  // A failing model: after its wait, and not before the time its provider named.
  if (isFailing(model)) return Math.max(tested + retryDelayMs(model.checkFailures, intervalMs), retryAt);
  // A model that did not answer in real work is asked when its rest is over:
  // the answer clears it, or puts it away.
  if ((model.useFailures ?? 0) > 0 && retryAt > 0) return Math.min(tested + intervalMs, Math.max(retryAt, tested));
  return tested + intervalMs;
}

/** Whether the automatic check is to ask this model now. Never, when the automatic check is off. */
export function isDue(model: CheckedModel, now: number, intervalMs: number): boolean {
  return intervalMs > 0 && nextCheckAt(model, intervalMs) <= now;
}

// ─── What real work says ─────────────────────────────────────────────────────

/** Requests of real work that fail in a row, for something the provider did, before the model is put away. */
export const USE_FAILURES_TO_HIDE = 3;
/** A model that did not answer rests this long when its provider named no time: doubled with each failure in a row. */
export const REST_FIRST_MS = 60_000;
export const REST_MAX_MS = 15 * 60_000;
/** The longest that a provider's "ask again in ..." is taken at its word. */
export const RETRY_AT_MAX_MS = 24 * 60 * 60_000;

/**
 * What a failed request says about its model.
 *
 * - "none": nothing. The request itself was refused (too long, a parameter
 *   the model does not take), or something else than the provider failed.
 * - "refused": the provider will say so again whatever is asked: there is no
 *   such model, the key is not accepted, the account has no credit.
 * - "limited": "not now" (429, 503, 529), with the wait the provider named
 *   and whether the limit is one that does not end soon (../provider-limits.ts).
 * - "down": no answer in time, no connection, an error of the provider.
 */
export type UseOutcome = { kind: "none" } | { kind: "refused" } | { kind: "limited"; waitMs: number | null; lasting: boolean } | { kind: "down" };

export function useOutcome(error: { code?: string; message: string; limit?: { waitMs: number | null; lasting: boolean } | null }): UseOutcome {
  if (error.code === "timeout" || error.code === "network_error") return { kind: "down" };
  const status = Number(/^Provider responded (\d{3})\b/.exec(error.message)?.[1] ?? 0);
  if (status === 401 || status === 402 || status === 404 || status === 410) return { kind: "refused" };
  if (status === 429 || status === 503 || status === 529) {
    return { kind: "limited", waitMs: error.limit?.waitMs ?? null, lasting: error.limit?.lasting ?? false };
  }
  // 403 is also what a provider answers to one request it will not serve, so it counts as one failure and no more.
  if (status === 403 || status === 408 || status === 425 || status >= 500) return { kind: "down" };
  return { kind: "none" };
}

/** How long a model rests after this many failures in a row, when its provider named no time. */
export function restMs(useFailures: number): number {
  return Math.min(REST_FIRST_MS * 2 ** Math.min(Math.max(useFailures, 1) - 1, 10), REST_MAX_MS);
}

export interface UseVerdict {
  useFailures: number;
  /** Put away: left out of the lists and of the app's choice until a check passes. */
  failing: boolean;
  /** Not chosen, and not checked, before this time. Null: no such time. */
  retryAt: number | null;
}

/** What becomes of a model after a request of real work failed. Null: nothing changes. */
export function afterUseFailure(prev: { failing: boolean; useFailures: number }, outcome: UseOutcome, now: number): UseVerdict | null {
  if (outcome.kind === "none") return null;
  const useFailures = prev.useFailures + 1;
  if (outcome.kind === "refused") return { useFailures, failing: true, retryAt: null };
  const named = outcome.kind === "limited" && outcome.waitMs !== null ? Math.min(Math.max(outcome.waitMs, 0), RETRY_AT_MAX_MS) : null;
  if (outcome.kind === "limited" && outcome.lasting) return { useFailures, failing: true, retryAt: named === null ? null : now + named };
  return { useFailures, failing: prev.failing || useFailures >= USE_FAILURES_TO_HIDE, retryAt: now + (named ?? restMs(useFailures)) };
}

/**
 * The count of failed requests after a check passed. A model that real work
 * had put away comes back on probation: it answers one word, and the next
 * request of real work that fails puts it away again.
 */
export function useFailuresAfterCheck(useFailures: number): number {
  return useFailures >= USE_FAILURES_TO_HIDE ? USE_FAILURES_TO_HIDE - 1 : 0;
}

/** Whether the model rests now: it did not answer a moment ago, and is not chosen by the app meanwhile. */
export function isResting(model: { retryAt?: Date | number | null }, now: number): boolean {
  return model.retryAt !== null && model.retryAt !== undefined && millis(model.retryAt) > now;
}

/** A model the app may choose by itself now: not failing, and not resting. */
export function usableNow(model: Pick<CheckedModel, "lastTestStatus" | "retryAt">, now: number): boolean {
  return !isFailing(model) && !isResting(model, now);
}
