import { AppError } from "./errors";
import { limitHint, type LimitHint } from "./provider-limits";
import { RETRY_STATUSES, retryAfterMs } from "./retry";

/**
 * The error for a provider's answer that is not a success, with what a "not
 * now" (429, 503, 529) said about its limit kept on it: the wait it named and
 * whether the limit is one that lasts (provider-limits.ts). A project's run
 * reads that to decide whether waiting for the model is worth it.
 *
 * Pure. The mark is a plain property, read by its shape and not by a class,
 * so that it holds across separately built parts of the server.
 */

export interface UpstreamLimit extends LimitHint {
  /** The provider's status: 429, 503 or 529. */
  status: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The error for the answer `status` with this message ("Provider responded
 * 429: …"). `body` is the answer's text and `retryAfter` its header of that
 * name: what they say about the wait is kept on the error.
 */
export function upstreamError(
  status: number,
  message: string,
  from: { body?: string | null; retryAfter?: string | null; code?: string } = {},
): AppError {
  const err = new AppError(502, from.code ?? "upstream_error", message);
  if (RETRY_STATUSES.has(status)) {
    const hint = limitHint(from.body);
    const limit: UpstreamLimit = { status, waitMs: retryAfterMs(from.retryAfter) ?? hint.waitMs, lasting: hint.lasting };
    (err as AppError & { limit?: UpstreamLimit }).limit = limit;
  }
  return err;
}

/**
 * What an error says about a provider's limit. Null when it is not a
 * provider's "not now": a refusal, a timeout, an answer that could not be
 * used. An error that carries no mark is read by the status in its message.
 */
export function limitOf(err: unknown): UpstreamLimit | null {
  if (!isRecord(err)) return null;
  const marked = err.limit;
  if (isRecord(marked) && typeof marked.status === "number") {
    return {
      status: marked.status,
      waitMs: typeof marked.waitMs === "number" && Number.isFinite(marked.waitMs) ? marked.waitMs : null,
      lasting: marked.lasting === true,
    };
  }
  const status = typeof err.message === "string" ? Number(/^Provider responded (\d{3})\b/.exec(err.message)?.[1] ?? 0) : 0;
  return RETRY_STATUSES.has(status) ? { status, waitMs: null, lasting: false } : null;
}
