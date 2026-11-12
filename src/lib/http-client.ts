import "server-only";
import { AppError } from "./errors";
import { assertSafeProviderUrl } from "./ssrf";

/**
 * SSRF-aware fetch for outbound provider calls.
 * - Re-validates the destination host against private ranges on every call.
 * - Refuses redirects (a redirect could point at an internal address). With
 *   `redirect: "manual"` the 3xx response is returned instead, so the caller
 *   can validate the next address itself (see src/lib/media/service.ts).
 * - Enforces a timeout until the response headers arrive.
 *
 * Note: DNS is checked before the request; a determined attacker controlling
 * DNS could still rebind between check and connect (TOCTOU). Defense in depth
 * at the network/egress layer is recommended in production (see README).
 */
export async function safeFetch(
  targetUrl: string,
  init: RequestInit,
  opts: { timeoutMs: number; allowHosts?: string[]; redirect?: "error" | "manual" },
): Promise<Response> {
  await assertSafeProviderUrl(targetUrl, { allowHosts: opts.allowHosts });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    return await fetch(targetUrl, {
      ...init,
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
}
