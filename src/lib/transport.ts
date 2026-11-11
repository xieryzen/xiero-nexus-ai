/**
 * Session cookies are HTTPS-only in production. A browser silently drops such
 * a cookie when the site is opened over plain http://, so sign-in appears to
 * do nothing. These helpers detect that case so the app can say so instead.
 *
 * This is a usability check, not a security control: it only decides whether
 * to show an explanation. The cookie's Secure flag is what protects sessions.
 *
 * Pure module (no server-only imports) so it can be unit-tested.
 */

export const INSECURE_TRANSPORT_MESSAGE =
  "Sign-in is turned off on this address: it is plain HTTP, and session cookies are HTTPS-only. " +
  "Open the site over https://, or set COOKIE_SECURE=false in .env and restart to allow plain HTTP. " +
  "If you are already on https://, set APP_URL to that address.";

function hostnameOf(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(1, Math.max(h.indexOf("]"), 1));
  const colon = h.lastIndexOf(":");
  return colon === -1 ? h : h.slice(0, colon);
}

/** Browsers accept Secure cookies on loopback addresses even over http://. */
export function isLoopbackHost(host: string): boolean {
  const name = hostnameOf(host);
  return (
    name === "localhost" ||
    name.endsWith(".localhost") ||
    name === "::1" ||
    /^127(\.\d{1,3}){3}$/.test(name)
  );
}

export interface TransportInput {
  /** Whether session cookies carry the Secure flag. */
  cookieSecure: boolean;
  /** Configured public URL of the app (APP_URL). */
  appUrl: string;
  /** `x-forwarded-proto` request header (Next.js fills it in when absent). */
  forwardedProto: string | null;
  /** `host` request header. */
  host: string | null;
}

/**
 * True when a Secure session cookie would be issued on a connection where the
 * browser is certain to drop it. Blocks only when that is known for sure.
 */
export function isInsecureTransport(input: TransportInput): boolean {
  if (!input.cookieSecure) return false; // plain HTTP explicitly allowed
  if (input.appUrl.trim().toLowerCase().startsWith("https://")) return false; // operator says the site is HTTPS
  const proto = input.forwardedProto?.split(",")[0]?.trim().toLowerCase();
  if (proto !== "http") return false; // https, or unknown
  if (!input.host) return false;
  return !isLoopbackHost(input.host);
}
