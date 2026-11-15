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
