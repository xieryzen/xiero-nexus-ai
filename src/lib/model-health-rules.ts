/**
 * When a model is checked, and what a check's result means. Pure.
 *
 * A model that failed its last check is "failing": it is left out of the
 * model lists and of the automatic choice of a model, until a check passes
 * again. A model that was never checked is offered: the first check comes
 * soon after it was added, and decides.
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
}

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
  const tested = typeof model.lastTestedAt === "number" ? model.lastTestedAt : model.lastTestedAt.getTime();
  return tested + (isFailing(model) ? retryDelayMs(model.checkFailures, intervalMs) : intervalMs);
}

/** Whether the automatic check is to ask this model now. Never, when the automatic check is off. */
export function isDue(model: CheckedModel, now: number, intervalMs: number): boolean {
  return intervalMs > 0 && nextCheckAt(model, intervalMs) <= now;
}
