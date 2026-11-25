/** An error that is safe to surface to clients (no secrets, no stack). */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/**
 * An error whose message is written for everyone. It is told as it is, also
 * to someone who is not shown the setup, whatever words it uses (shown.ts).
 */
export class PlainError extends AppError {
  /** Told by this mark, not by the class: it holds across separately built parts of the server. */
  readonly plain = true;
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = "PlainError";
  }
}

export function isPlainError(err: unknown): boolean {
  return err instanceof AppError && (err as { plain?: unknown }).plain === true;
}

/**
 * The error of a request that never got to the other side: no connection was
 * made (it was refused, there is no way there, the name has no address just
 * now). An AppError like the others, with a mark, so that whoever asks why a
 * model did not answer can tell "it was never asked" from "it was asked, and
 * something went wrong then": the first costs nothing to try again, and when
 * it happens with every provider at once it is this server that is cut off
 * (reach.ts). By a mark and not a class of its own: its name stays AppError,
 * which is what a tool's error is told by (agent/loop.ts).
 */
export function notReached(message: string): AppError {
  return Object.assign(new AppError(502, "network_error", message), { notReached: true });
}

/** True for a request that never got to the other side: notReached above, or a name that no address was found for. */
export function wasNotReached(err: unknown): boolean {
  return err instanceof AppError && ((err as { notReached?: unknown }).notReached === true || err.code === "dns_error");
}

/**
 * What Node and its fetch call a connection that was not made. A certificate
 * that is not accepted and a redirect that is not followed are not among
 * them: there the other side was reached, and asking again changes nothing.
 */
const NO_CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ENETDOWN",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * Whether what fetch threw says that no connection was made. fetch throws a
 * TypeError ("fetch failed") whose cause holds the code; where a name has
 * several addresses the cause holds one error for each.
 */
export function connectionNotMade(err: unknown): boolean {
  const seen = new Set<unknown>();
  const look = (value: unknown, depth: number): boolean => {
    if (!value || typeof value !== "object" || seen.has(value) || depth > 4) return false;
    seen.add(value);
    const one = value as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof one.code === "string" && NO_CONNECTION_CODES.has(one.code)) return true;
    if (Array.isArray(one.errors) && one.errors.some((inner) => look(inner, depth + 1))) return true;
    return look(one.cause, depth + 1);
  };
  return look(err, 0);
}

export const Errors = {
  unauthorized: (m = "Authentication required") =>
    new AppError(401, "unauthorized", m),
  forbidden: (m = "You do not have permission to do that") =>
    new AppError(403, "forbidden", m),
  notFound: (m = "Not found") => new AppError(404, "not_found", m),
  badRequest: (m = "Invalid request") => new AppError(400, "bad_request", m),
  conflict: (m = "Already exists") => new AppError(409, "conflict", m),
  rateLimited: (m = "Too many requests") =>
    new AppError(429, "rate_limited", m),
  upstream: (m = "Upstream provider error") =>
    new AppError(502, "upstream_error", m),
};

/**
 * Reduce an arbitrary upstream/provider error to a short, safe string.
 * Strips anything that could contain a key, and truncates to `max` characters.
 */
export function sanitizeUpstreamError(input: unknown, max = 300): string {
  let s =
    input instanceof Error
      ? input.message
      : typeof input === "string"
        ? input
        : "Unknown upstream error";
  // Remove bearer tokens / sk- style keys / long opaque tokens. Keys that are
  // shorter than the last rule, or contain characters that end a word, have
  // their own: Anthropic (sk-ant-…), Google (AIza…, 39 characters), Tavily
  // (tvly-…), this app's own API keys (xn_…), and a key in a URL (?key=…).
  s = s
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(sk|rk|pk)[-_][A-Za-z0-9_-]{8,}/g, "[redacted-key]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "[redacted-key]")
    .replace(/\b(tvly|xn)[-_][A-Za-z0-9_-]{8,}/g, "[redacted-key]")
    .replace(/([?&](?:key|api_key|apikey|access_token|token)=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]");
  return s.length > max ? `${s.slice(0, max - 3)}…` : s;
}
