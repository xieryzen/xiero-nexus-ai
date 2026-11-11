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
 * Strips anything that could contain a key, and truncates.
 */
export function sanitizeUpstreamError(input: unknown): string {
  let s =
    input instanceof Error
      ? input.message
      : typeof input === "string"
        ? input
        : "Unknown upstream error";
  // Remove bearer tokens / sk- style keys / long opaque tokens.
  s = s
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/\b(sk|rk|pk)[-_][A-Za-z0-9]{8,}\b/g, "[redacted-key]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]");
  return s.length > 300 ? `${s.slice(0, 297)}…` : s;
}
