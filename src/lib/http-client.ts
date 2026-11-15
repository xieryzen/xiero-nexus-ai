import "server-only";
import { AppError } from "./errors";
import { Patience, fetchWithRetries, retryKey, retryLimit } from "./retry";
import { assertSafeProviderUrl } from "./ssrf";

/**
 * SSRF-aware fetch for outbound provider calls.
 * - Re-validates the destination host against private ranges on every call.
 * - Refuses redirects (a redirect could point at an internal address). With
 *   `redirect: "manual"` the 3xx response is returned instead, so the caller
 *   can validate the next address itself (see src/lib/media/service.ts).
 * - Enforces a timeout until the response headers arrive.
 * - With `retries`, sends the request again when the answer is "not now"
 *   (429, 503, 529), after the wait the other side asks for or a growing one
 *   of its own (see ./retry.ts). The timeout is for each time. Model providers
 *   are asked this way, through providerFetch below; nothing else is.
 * - Never served from, or stored in, the framework's fetch cache.
 *
 * Note: DNS is checked before the request; a determined attacker controlling
 * DNS could still rebind between check and connect (TOCTOU). Defense in depth
 * at the network/egress layer is recommended in production (see README).
 */
export async function safeFetch(
  targetUrl: string,
  init: RequestInit,
  opts: { timeoutMs: number; allowHosts?: string[]; redirect?: "error" | "manual"; retries?: number },
): Promise<Response> {
  await assertSafeProviderUrl(targetUrl, { allowHosts: opts.allowHosts });

  const once = async (): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      return await fetch(targetUrl, {
        ...init,
        // Said outright, because the framework otherwise keeps the answer to a
        // GET made while a GET request is being handled and returns it again
        // for the same address: a video's status would then never change.
        cache: "no-store",
        redirect: opts.redirect ?? "error",
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new AppError(504, "timeout", "Upstream request timed out");
      }
      if (err instanceof AppError) throw err;
      throw new AppError(502, "network_error", "Could not reach provider");
    } finally {
      clearTimeout(timer);
    }
  };

  const retries = opts.retries ?? 0;
  if (retries <= 0) return once();
  // A body that is a stream can be read once only: such a request is sent once.
  const body = init.body;
  const again = body === undefined || body === null || typeof body === "string" || body instanceof Uint8Array || body instanceof FormData;
  if (!again) return once();
  return fetchWithRetries(once, { limit: retries, key: retryKey(targetUrl, typeof body === "string" ? body : null), patience });
}

/** Which models this process waited for in vain (see ./retry.ts). */
const patience = new Patience();

/**
 * safeFetch for a request to a model provider. A provider that answers "too
 * many requests" or "busy" is asked again after a wait, `PROVIDER_RETRIES`
 * times (4 unless set; 0 turns it off): on a free tier that is the difference
 * between an agent that finishes its task and one that fails at the first
 * limit.
 */
export function providerFetch(
  targetUrl: string,
  init: RequestInit,
  opts: { timeoutMs: number; allowHosts?: string[]; redirect?: "error" | "manual" },
): Promise<Response> {
  return safeFetch(targetUrl, init, { ...opts, retries: retryLimit(process.env.PROVIDER_RETRIES) });
}
