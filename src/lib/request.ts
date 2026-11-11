/** Extract client IP + user agent from a request, for audit/rate-limit use. */
export function getClientMeta(req: Request): { ip: string; userAgent: string } {
  const h = req.headers;
  const fwd = h.get("x-forwarded-for");
  const ip =
    (fwd ? fwd.split(",")[0]!.trim() : "") ||
    h.get("x-real-ip") ||
    "unknown";
  const userAgent = h.get("user-agent") ?? "unknown";
  return { ip, userAgent };
}
