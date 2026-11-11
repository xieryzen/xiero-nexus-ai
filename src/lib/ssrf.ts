import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { AppError } from "./errors";

/**
 * SSRF defense for administrator-configured Base URLs.
 * Pure/testable: DNS resolver and allowlist are injected.
 */

export function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255))
    return true; // treat malformed as unsafe
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a >= 224) return true; // multicast / reserved
  return false;
}

export function isPrivateIpv6(ip: string): boolean {
  const addr = ip.toLowerCase().split("%")[0]!;
  if (addr === "::1" || addr === "::") return true; // loopback / unspecified
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true; // unique local
  if (addr.startsWith("fe80")) return true; // link-local
  if (addr.startsWith("ff")) return true; // multicast
  // IPv4-mapped (::ffff:a.b.c.d)
  const mapped = addr.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]!);
  return false;
}

export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateIpv4(ip);
  if (v === 6) return isPrivateIpv6(ip);
  return true;
}

export interface UrlCheckOptions {
  allowHosts?: string[];
  resolver?: (host: string) => Promise<{ address: string }[]>;
}

/** Validate scheme/shape without touching DNS. Throws AppError on failure. */
export function parseProviderUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new AppError(400, "invalid_url", "Base URL is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AppError(
      400,
      "invalid_url",
      "Base URL must use http or https",
    );
  }
  if (url.username || url.password) {
    throw new AppError(
      400,
      "invalid_url",
      "Base URL must not contain credentials",
    );
  }
  return url;
}

const defaultResolver = async (host: string) => {
  const res = await lookup(host, { all: true });
  return res.map((r) => ({ address: r.address }));
};

/**
 * Full validation: scheme + DNS resolution against private ranges.
 * Hosts in `allowHosts` (exact, case-insensitive) bypass the private-IP block
 * — used only for explicitly-permitted local model endpoints.
 */
export async function assertSafeProviderUrl(
  input: string,
  opts: UrlCheckOptions = {},
): Promise<URL> {
  const url = parseProviderUrl(input);
  const host = url.hostname.toLowerCase();
  const allow = (opts.allowHosts ?? []).map((h) => h.toLowerCase());
  if (allow.includes(host)) return url;

  // Literal IP host?
  if (isIP(host)) {
    if (isPrivateIp(host)) {
      throw new AppError(
        400,
        "blocked_host",
        "Base URL resolves to a disallowed private address",
      );
    }
    return url;
  }

  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new AppError(400, "blocked_host", "localhost is not allowed");
  }

  const resolver = opts.resolver ?? defaultResolver;
  let addresses: { address: string }[];
  try {
    addresses = await resolver(host);
  } catch {
    throw new AppError(400, "dns_error", "Could not resolve Base URL host");
  }
  if (addresses.length === 0) {
    throw new AppError(400, "dns_error", "Base URL host did not resolve");
  }
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new AppError(
        400,
        "blocked_host",
        "Base URL resolves to a disallowed private address",
      );
    }
  }
  return url;
}
