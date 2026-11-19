import "server-only";
import { AppError } from "./errors";
import { safeFetch } from "./http-client";
import { assertSafeProviderUrl } from "./ssrf";
import { readBodyCapped } from "./media/http";

/**
 * Requests to addresses that come from a model or a user rather than from an
 * administrator: pages an agent reads, APIs it calls, a document added from a
 * link. Every address, and every redirect, is checked against private network
 * ranges before it is contacted.
 */

function hostList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Hosts agents may reach. Empty means any public host. An entry matches the
 * host itself and its subdomains.
 */
export function agentAllowedHosts(): string[] {
  return hostList("AGENT_HTTP_ALLOWED_HOSTS");
}

/** Hosts on a private network that agents may reach all the same. */
function agentPrivateHosts(): string[] {
  return hostList("AGENT_HTTP_PRIVATE_HOSTS");
}

export function hostMatches(host: string, entries: string[]): boolean {
  const h = host.toLowerCase();
  return entries.some((entry) => h === entry || h.endsWith(`.${entry.replace(/^\./, "")}`));
}

export function parseWebUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new AppError(400, "invalid_url", "That is not a valid web address");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AppError(400, "invalid_url", "Only http and https addresses can be used");
  }
  if (url.username || url.password) {
    throw new AppError(400, "invalid_url", "The address must not contain a user name or password");
  }
  return url;
}

function assertHostAllowed(url: URL): void {
  const allowed = agentAllowedHosts();
  if (allowed.length > 0 && !hostMatches(url.hostname, [...allowed, ...agentPrivateHosts()])) {
    throw new AppError(
      403,
      "host_not_allowed",
      `${url.hostname} is not among the hosts this server lets agents reach`,
    );
  }
}

/**
 * Whether an agent may be taken to an address: a web address, among the
 * hosts agents may reach, and not on a private network. Throws an AppError
 * that is safe to show. The address is not contacted.
 */
export async function assertWebAddress(input: string): Promise<URL> {
  const url = parseWebUrl(input);
  assertHostAllowed(url);
  try {
    await assertSafeProviderUrl(url.toString(), { allowHosts: agentPrivateHosts() });
  } catch (err) {
    if (err instanceof AppError) {
      const messages: Record<string, string> = {
        dns_error: `Could not find the host ${url.hostname}`,
        blocked_host: `${url.hostname} is on a private network, which cannot be reached from here`,
        invalid_url: "That is not a valid web address",
      };
      throw new AppError(err.status, err.code, messages[err.code] ?? err.message);
    }
    throw err;
  }
  return url;
}

/** Whether a host is among the ones agents may reach (always, when the server lists none). */
export function agentHostAllowed(host: string): boolean {
  const allowed = agentAllowedHosts();
  return allowed.length === 0 || hostMatches(host, [...allowed, ...agentPrivateHosts()]);
}

export interface WebRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Redirects to follow; 0 returns the redirect itself. */
  maxRedirects?: number;
}

export interface WebResponse {
  status: number;
  /** The address the answer came from, after redirects. */
  url: string;
  contentType: string;
  location: string | null;
  bytes: Buffer;
}

/** Fetch a public address. Throws an AppError that is safe to show. */
export async function fetchWeb(input: string, req: WebRequest = {}): Promise<WebResponse> {
  const timeoutMs = req.timeoutMs ?? 20_000;
  const maxBytes = req.maxBytes ?? 2 * 1024 * 1024;
  const maxRedirects = req.maxRedirects ?? 0;
  let url = parseWebUrl(input);
  let method = (req.method ?? "GET").toUpperCase();
  let body = req.body;

  for (let hop = 0; ; hop++) {
    assertHostAllowed(url);
    let res: Response;
    try {
      res = await safeFetch(
        url.toString(),
        { method, headers: req.headers, body: method === "GET" || method === "HEAD" ? undefined : body },
        { timeoutMs, allowHosts: agentPrivateHosts(), redirect: "manual" },
      );
    } catch (err) {
      if (err instanceof AppError) {
        // The shared helpers word their errors for provider settings.
        const messages: Record<string, string> = {
          timeout: "The request timed out",
          network_error: `Could not reach ${url.hostname}`,
          dns_error: `Could not find the host ${url.hostname}`,
          blocked_host: `${url.hostname} is on a private network, which cannot be reached from here`,
          invalid_url: "That is not a valid web address",
        };
        throw new AppError(err.status, err.code, messages[err.code] ?? err.message);
      }
      throw err;
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location && hop < maxRedirects) {
      void res.body?.cancel().catch(() => undefined);
      url = parseWebUrl(new URL(location, url).toString());
      // As browsers do: after 303, and after 301/302 to a POST, the next request is a GET.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await readBodyCapped(res, { maxBytes, timeoutMs });
    } catch (err) {
      if (err instanceof AppError && err.code === "upstream_too_large") {
        throw new AppError(502, err.code, "The response is larger than this server reads");
      }
      if (err instanceof AppError && err.code === "timeout") {
        throw new AppError(504, err.code, "The response took too long to arrive");
      }
      throw err;
    }
    return {
      status: res.status,
      url: url.toString(),
      contentType: (res.headers.get("content-type") ?? "").toLowerCase(),
      location,
      bytes,
    };
  }
}

/** True for a content type that can be read as text. */
export function isTextContentType(contentType: string): boolean {
  return (
    contentType === "" ||
    contentType.startsWith("text/") ||
    /\b(json|xml|javascript|yaml|csv|x-www-form-urlencoded)\b/.test(contentType)
  );
}
