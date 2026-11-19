import "server-only";
import { CdpConnection, CdpError } from "./cdp";

/**
 * The browser service: a Chromium that runs apart from the app and is
 * driven over the DevTools protocol. BROWSER_URL says where it is:
 *
 *   http://host:9223/?token=…   the service of this repository
 *                               (scripts/host/browser), or any Chromium that
 *                               answers /json/version
 *   ws://host:port/…            a DevTools address as it is
 *
 * Without BROWSER_URL there is no browser, and agents are not handed the
 * tool. The app never starts a browser itself: a browser that opens what an
 * agent asks for does not belong in the process that holds the keys.
 */

/** The browser cannot be used just now. The message is for whoever set it up; it names no token. */
export class BrowserProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserProblem";
  }
}

export interface BrowserStatus {
  /** BROWSER_URL is set. */
  configured: boolean;
  /** Whether the service answered when it was last asked. Null before it was asked. */
  reachable: boolean | null;
  /** What the browser calls itself. */
  product: string | null;
  /** What it tells a site that it is: nothing is put in its place. */
  userAgent: string | null;
  /**
   * Whether the service says that it keeps pages from private networks, as
   * the service of this repository does. Null when it does not say.
   */
  filtered: boolean | null;
  /** Hosts on private networks the service lets pages reach all the same. */
  allowPrivate: string[];
  /** Where the service is: its host and port, without what signs in. */
  where: string | null;
  error: string | null;
  checkedAt: number | null;
}

interface ServiceStore {
  conn: CdpConnection | null;
  connecting: Promise<CdpConnection> | null;
  status: BrowserStatus;
  /** Called with every new connection: the sessions hear what the browser says through these. */
  onConnect: Set<(conn: CdpConnection) => void>;
}

const g = globalThis as unknown as { __xnBrowserService?: ServiceStore };

function store(): ServiceStore {
  g.__xnBrowserService ??= {
    conn: null,
    connecting: null,
    status: { configured: false, reachable: null, product: null, userAgent: null, filtered: null, allowPrivate: [], where: null, error: null, checkedAt: null },
    onConnect: new Set(),
  };
  return g.__xnBrowserService;
}

function configuredUrl(): URL | null {
  const raw = process.env.BROWSER_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return /^(https?|wss?):$/.test(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

/** Whether a browser service is set up. Says nothing about whether it answers. */
export function browserConfigured(): boolean {
  return configuredUrl() !== null;
}

interface Endpoint {
  address: string;
  product: string | null;
  filtered: boolean | null;
  allowPrivate: string[];
}

/** Where to connect, and what the service says of itself. */
async function endpoint(url: URL): Promise<Endpoint> {
  if (url.protocol === "ws:" || url.protocol === "wss:") {
    return { address: url.toString(), product: null, filtered: null, allowPrivate: [] };
  }
  const ask = new URL(url.toString());
  ask.pathname = `${url.pathname.replace(/\/+$/, "")}/json/version`;
  let res: Response;
  try {
    res = await fetch(ask, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8_000), cache: "no-store" });
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : err instanceof Error ? err.message : String(err);
    throw new BrowserProblem(`The browser service at ${url.host} does not answer (${/timeout|aborted/i.test(cause) ? "no answer in 8 s" : cause.slice(0, 120)}).`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new BrowserProblem(`The browser service at ${url.host} did not take the token of BROWSER_URL.`);
  }
  if (!res.ok) throw new BrowserProblem(`The browser service at ${url.host} answered ${res.status}.`);
  let body: { Browser?: unknown; webSocketDebuggerUrl?: unknown; gate?: { egress?: unknown; allowPrivate?: unknown } };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new BrowserProblem(`What answers at ${url.host} is not a browser service.`);
  }
  if (typeof body.webSocketDebuggerUrl !== "string") throw new BrowserProblem(`What answers at ${url.host} is not a browser service.`);
  let path: string;
  try {
    path = new URL(body.webSocketDebuggerUrl).pathname;
  } catch {
    throw new BrowserProblem(`What answers at ${url.host} is not a browser service.`);
  }
  // The address the browser gives is as it sees itself; the app connects where BROWSER_URL says, with what signs in.
  const address = new URL(url.toString());
  address.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  address.pathname = path;
  return {
    address: address.toString(),
    product: typeof body.Browser === "string" ? body.Browser.slice(0, 80) : null,
    filtered: body.gate ? body.gate.egress === "filtered" : null,
    allowPrivate: Array.isArray(body.gate?.allowPrivate) ? (body.gate.allowPrivate as unknown[]).filter((h): h is string => typeof h === "string").slice(0, 20) : [],
  };
}

function note(patch: Partial<BrowserStatus>): BrowserStatus {
  const s = store();
  s.status = { ...s.status, ...patch, checkedAt: Date.now() };
  return s.status;
}

/** The connection to the browser: the one there is, or a new one. */
export async function connection(): Promise<CdpConnection> {
  const s = store();
  if (s.conn && !s.conn.closed) return s.conn;
  if (s.connecting) return s.connecting;
  const url = configuredUrl();
  if (!url) {
    note({ configured: false, reachable: null, where: null, error: null });
    throw new BrowserProblem("No browser service is set up (BROWSER_URL).");
  }
  s.connecting = (async () => {
    try {
      const where = await endpoint(url);
      let conn: CdpConnection;
      try {
        conn = await CdpConnection.connect(where.address);
      } catch (err) {
        throw new BrowserProblem(`The browser service at ${url.host} did not let the app in (${err instanceof CdpError ? err.message : "no connection"}).`);
      }
      let product = where.product;
      let userAgent: string | null = null;
      try {
        const version = await conn.send<{ product?: string; userAgent?: string }>("Browser.getVersion");
        product = version.product?.slice(0, 80) ?? product;
        userAgent = version.userAgent?.slice(0, 300) ?? null;
        await conn.send("Target.setDiscoverTargets", { discover: true });
      } catch {
        // A browser that does not say what it is works all the same.
      }
      s.conn = conn;
      conn.onClose(() => {
        if (s.conn === conn) s.conn = null;
      });
      note({ configured: true, reachable: true, product, userAgent, filtered: where.filtered, allowPrivate: where.allowPrivate, where: url.host, error: null });
      for (const tell of [...s.onConnect]) {
        try {
          tell(conn);
        } catch {
          // The sessions' own trouble.
        }
      }
      return conn;
    } catch (err) {
      const message = err instanceof BrowserProblem ? err.message : `The browser service at ${url.host} could not be used.`;
      note({ configured: true, reachable: false, where: url.host, error: message });
      throw err instanceof BrowserProblem ? err : new BrowserProblem(message);
    } finally {
      s.connecting = null;
    }
  })();
  return s.connecting;
}

/** Hear every new connection to the browser. */
export function onBrowserConnect(tell: (conn: CdpConnection) => void): void {
  store().onConnect.add(tell);
}

/** The connection there is now, without making one. */
export function openConnection(): CdpConnection | null {
  const conn = store().conn;
  return conn && !conn.closed ? conn : null;
}

/**
 * How the browser service is. Asked anew when the last answer is older than
 * half a minute, or when `fresh` says so.
 */
export async function browserStatus(fresh = false): Promise<BrowserStatus> {
  const s = store();
  const url = configuredUrl();
  if (!url) return note({ configured: false, reachable: null, product: null, userAgent: null, filtered: null, allowPrivate: [], where: null, error: null });
  if (s.conn && !s.conn.closed && !fresh) return { ...s.status, configured: true, reachable: true };
  if (!fresh && s.status.configured && s.status.checkedAt && Date.now() - s.status.checkedAt < 30_000) return s.status;
  try {
    await connection();
  } catch {
    // What stood in the way is in the status.
  }
  return store().status;
}

/** What is known of the service without asking it. */
export function lastBrowserStatus(): BrowserStatus {
  const s = store();
  return configuredUrl() ? { ...s.status, configured: true } : { ...s.status, configured: false, reachable: null };
}

/** Close the connection. Every page of every run is closed by the browser with it. */
export function closeConnection(): void {
  const s = store();
  const conn = s.conn;
  s.conn = null;
  if (conn) conn.close();
}
