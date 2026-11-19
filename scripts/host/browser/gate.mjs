#!/usr/bin/env node
// The browser service of Xiero Nexus AI: a Chromium that the app drives, kept
// apart from the app and from the network the app lives in.
//
//   BROWSER_TOKEN=... node gate.mjs
//
// It does three things, with nothing but Node (18 or newer) and a Chromium:
//
//   1. It starts the Chromium, without a window, and starts it again when it
//      ends.
//   2. It lets the app in, and nobody else. The app speaks the DevTools
//      protocol with the browser; whoever can do that can do anything in it.
//      Chromium asks for no password, so this script stands in front: every
//      request needs the token, as "?token=..." or "Authorization: Bearer ...".
//   3. It decides where pages may go. Everything the browser loads passes
//      through a proxy in this script, which refuses addresses on private
//      networks: this machine, the network it is in, the metadata service of
//      a cloud. A page an agent opens cannot be used to look around in there.
//
// Settings, from the environment:
//
//   BROWSER_TOKEN        Needed: at least 16 characters. The app has the same
//                        in its BROWSER_URL (http://host:9223/?token=...).
//   PORT                 Where the app connects (9223).
//   HOST                 The address to listen on (0.0.0.0).
//   CHROME_BIN           The Chromium to start. Default: the first of
//                        chromium, chromium-browser, google-chrome,
//                        google-chrome-stable that is installed.
//   CHROME_HEADLESS      "new" (default) for a full Chromium; "shell" for a
//                        build that is only the headless shell.
//   CHROME_NO_SANDBOX    "1": start Chromium with --no-sandbox, as it has to
//                        be inside a container, where the container is the
//                        boundary.
//   CHROME_ARGS          More arguments for Chromium, separated by spaces.
//   PROFILE_DIR          Where Chromium keeps its files (a new folder under
//                        the temporary folder, removed at the end).
//   ALLOW_PRIVATE_HOSTS  Hosts on a private network that pages may reach all
//                        the same, separated by commas. For tests, and for a
//                        site of your own on your own network.
//
// What it answers:
//
//   GET /healthz                      200 when Chromium is running. No token.
//   GET /json/version?token=...       What the browser is, where to connect
//                                     ("webSocketDebuggerUrl"), and that this
//                                     gate filters where pages go ("gate").
//   GET /devtools/browser/<id>?token=...   The DevTools protocol, as a
//                                     WebSocket, passed on to Chromium.
//
// Everything else is 404; a missing or wrong token is 401.
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

export const GATE_VERSION = 1;

// ─── Where pages may go ──────────────────────────────────────────────────────

function privateV4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function privateV6(ip) {
  const addr = ip.toLowerCase().split("%")[0];
  if (addr === "::1" || addr === "::") return true;
  if (/^f[cd]/.test(addr) || /^fe[89ab]/.test(addr) || addr.startsWith("ff")) return true;
  // An IPv4 address written as IPv6, in dots or in hexadecimal.
  const dotted = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (dotted) return privateV4(dotted[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return privateV4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  // 64:ff9b::/96 carries an IPv4 address too.
  if (addr.startsWith("64:ff9b:")) return true;
  return false;
}

/** Whether an address is one a page has no business with: this machine, a private network, a cloud's metadata. */
export function isPrivateAddress(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return privateV4(ip);
  if (kind === 6) return privateV6(ip);
  return true;
}

/** "a.example, 10.0.0.5" as a list of lower-case hosts. */
export function hostList(text) {
  return String(text ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^\[|\]$/g, ""))
    .filter(Boolean);
}

/** "host:port" or "[v6]:port" as its two parts. The port defaults to `fallback`. */
export function splitHostPort(text, fallback) {
  const value = String(text ?? "").trim();
  const bracket = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(value);
  if (bracket) return { host: bracket[1].toLowerCase(), port: bracket[2] ? Number(bracket[2]) : fallback };
  const plain = /^([^:]+)(?::(\d{1,5}))?$/.exec(value);
  if (plain) return { host: plain[1].toLowerCase(), port: plain[2] ? Number(plain[2]) : fallback };
  // An IPv6 address without brackets and without a port.
  if (net.isIP(value) === 6) return { host: value.toLowerCase(), port: fallback };
  return null;
}

/**
 * Where to connect for a host a page asked for: the address, or why not.
 * `allow` are hosts that may be reached although they are private; `closed`
 * are ports on this machine that no page reaches whatever is allowed (the
 * browser's own DevTools port, and this gate).
 */
export async function destination(host, port, { allow = [], closed = [], resolve = defaultResolve } = {}) {
  const name = String(host ?? "").toLowerCase().replace(/\.$/, "");
  if (!name || !Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, why: "not an address" };
  const allowed = allow.includes(name);
  const loopback = name === "localhost" || name.endsWith(".localhost") || (net.isIP(name) !== 0 && /^(127\.|::1$)/.test(name));
  if (loopback && closed.includes(port)) return { ok: false, why: "a port of the browser service itself" };
  if (net.isIP(name) !== 0) {
    if (isPrivateAddress(name) && !allowed) return { ok: false, why: "an address on a private network" };
    return { ok: true, address: name };
  }
  if (loopback && !allowed) return { ok: false, why: "this machine" };
  let found;
  try {
    found = await resolve(name);
  } catch {
    return { ok: false, why: "a name that could not be found", status: 502 };
  }
  if (found.length === 0) return { ok: false, why: "a name that could not be found", status: 502 };
  if (!allowed && found.some((address) => isPrivateAddress(address))) {
    return { ok: false, why: "a name that leads to a private network" };
  }
  if (allowed && closed.includes(port) && found.some((address) => /^(127\.|::1$)/.test(address))) {
    return { ok: false, why: "a port of the browser service itself" };
  }
  // The connection is made to the address that was looked at, not to the
  // name: a name cannot lead somewhere else between the look and the call.
  return { ok: true, address: found.find((address) => net.isIP(address) === 4) ?? found[0] };
}

async function defaultResolve(name) {
  return (await lookup(name, { all: true })).map((entry) => entry.address);
}

/** Whether the token a request brought is the one of this gate. Takes the same time whatever is wrong. */
export function tokenMatches(given, token) {
  const a = createHash("sha256").update(String(given ?? "")).digest();
  const b = createHash("sha256").update(String(token ?? "")).digest();
  return Boolean(token) && timingSafeEqual(a, b);
}

/** The token of a request: "?token=" or "Authorization: Bearer". */
export function tokenOf(url, headers) {
  const fromQuery = url.searchParams.get("token");
  if (fromQuery) return fromQuery;
  const header = String(headers.authorization ?? "");
  return /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, "").trim() : "";
}

// ─── The proxy every page request passes through ─────────────────────────────

function refusal(why, status = 403) {
  const body =
    "<!doctype html><meta charset=utf-8><title>Not opened</title>" +
    `<p>The browser service did not open this address: it is ${why}.</p>`;
  return (
    `HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Bad Gateway"}\r\n` +
    "Content-Type: text/html; charset=utf-8\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    `X-Browser-Gate: ${status === 403 ? "refused" : "not-found"}\r\n` +
    "Connection: close\r\n\r\n" +
    body
  );
}

function link(a, b) {
  a.pipe(b);
  b.pipe(a);
  const end = () => {
    a.destroy();
    b.destroy();
  };
  a.on("error", end);
  b.on("error", end);
  a.on("close", end);
  b.on("close", end);
}

/**
 * An HTTP proxy for the browser alone. It listens on this machine only. A
 * request for a secure site arrives as CONNECT and is passed on untouched; a
 * plain one is passed on with its first line rewritten, one request to a
 * connection.
 */
export function createEgressProxy(options) {
  const stats = { passed: 0, refused: 0 };
  const server = net.createServer((client) => {
    client.setTimeout(30_000, () => client.destroy());
    client.on("error", () => undefined);
    let head = Buffer.alloc(0);
    const onData = async (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > 64 * 1024) client.destroy();
        return;
      }
      client.removeListener("data", onData);
      client.pause();
      const lines = head.subarray(0, end).toString("latin1").split("\r\n");
      const rest = head.subarray(end + 4);
      const [method, target, version] = (lines[0] ?? "").split(" ");
      let where = null;
      let path = "";
      if (method === "CONNECT") {
        where = splitHostPort(target, 443);
      } else {
        try {
          const url = new URL(target);
          if (url.protocol === "http:") {
            where = { host: url.hostname.replace(/^\[|\]$/g, "").toLowerCase(), port: url.port ? Number(url.port) : 80 };
            path = `${url.pathname}${url.search}`;
          }
        } catch {
          where = null;
        }
      }
      if (!where || !version) {
        client.end(refusal("not an address a browser asks a proxy for"));
        return;
      }
      const found = await destination(where.host, where.port, options);
      if (!found.ok) {
        stats.refused++;
        options.onRefused?.(where.host, where.port, found.why);
        client.end(refusal(found.why, found.status ?? 403));
        return;
      }
      stats.passed++;
      const upstream = net.connect({ host: found.address, port: where.port });
      upstream.setTimeout(120_000, () => upstream.destroy());
      upstream.once("error", () => {
        if (!client.destroyed) client.end(refusal("an address that did not answer", 502));
      });
      upstream.once("connect", () => {
        client.setTimeout(0);
        if (method === "CONNECT") {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        } else {
          // One request to a connection, so that the next one is looked at too.
          const headers = lines
            .slice(1)
            .filter((line) => !/^(proxy-connection|connection|proxy-authorization):/i.test(line));
          upstream.write(`${method} ${path || "/"} ${version}\r\n${headers.join("\r\n")}\r\nConnection: close\r\n\r\n`);
        }
        if (rest.length > 0) upstream.write(rest);
        link(client, upstream);
        client.resume();
      });
    };
    client.on("data", onData);
  });
  return { server, stats };
}

// ─── Chromium ────────────────────────────────────────────────────────────────

/** The Chromium to start: what CHROME_BIN names, or the first that is installed. */
export function findChrome(env = process.env) {
  if (env.CHROME_BIN) return env.CHROME_BIN;
  const names = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome"];
  for (const dir of String(env.PATH ?? "").split(delimiter)) {
    for (const name of names) {
      if (dir && existsSync(join(dir, name))) return join(dir, name);
    }
  }
  return null;
}

/** The arguments Chromium is started with. */
export function chromeArguments({ profile, proxyPort, headless = "new", noSandbox = false, extra = [] }) {
  return [
    headless === "shell" ? "--headless" : "--headless=new",
    ...(noSandbox ? ["--no-sandbox"] : []),
    // A port of its own choosing, on this machine only: this gate reads which.
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profile}`,
    // Everything goes through the proxy of this gate, this machine included.
    `--proxy-server=http://127.0.0.1:${proxyPort}`,
    "--proxy-bypass-list=<-loopback>",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--metrics-recording-only",
    "--mute-audio",
    "--password-store=basic",
    "--use-mock-keychain",
    "--window-size=1280,800",
    ...extra,
    "about:blank",
  ];
}

// ─── The gate ────────────────────────────────────────────────────────────────

function log(message) {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

function answer(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
  res.end(text);
}

async function main() {
  const token = process.env.BROWSER_TOKEN ?? "";
  if (token.length < 16) {
    console.error("error: BROWSER_TOKEN is needed, with at least 16 characters. Make one with: openssl rand -hex 24");
    process.exit(2);
  }
  const chromeBin = findChrome();
  if (!chromeBin) {
    console.error("error: no Chromium was found. Install one, or name it in CHROME_BIN.");
    process.exit(2);
  }
  const port = Number(process.env.PORT ?? 9223);
  const host = process.env.HOST ?? "0.0.0.0";
  const allow = hostList(process.env.ALLOW_PRIVATE_HOSTS);
  const ownProfile = !process.env.PROFILE_DIR;
  const profile = process.env.PROFILE_DIR || mkdtempSync(join(tmpdir(), "xiero-browser-"));

  /** The DevTools port Chromium chose, once it said so. */
  let cdpPort = 0;
  let chrome = null;
  let stopping = false;
  let starts = 0;

  const proxy = createEgressProxy({
    allow,
    get closed() {
      return [port, cdpPort].filter(Boolean);
    },
    onRefused: (name, toPort, why) => log(`refused ${name}:${toPort}: ${why}`),
  });
  await new Promise((resolve) => proxy.server.listen(0, "127.0.0.1", resolve));
  const proxyPort = proxy.server.address().port;

  const startChrome = () => {
    if (stopping) return;
    starts++;
    cdpPort = 0;
    const args = chromeArguments({
      profile,
      proxyPort,
      headless: process.env.CHROME_HEADLESS === "shell" ? "shell" : "new",
      noSandbox: process.env.CHROME_NO_SANDBOX === "1",
      extra: String(process.env.CHROME_ARGS ?? "").split(/\s+/).filter(Boolean),
    });
    chrome = spawn(chromeBin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let said = "";
    chrome.stderr.on("data", (chunk) => {
      if (cdpPort) return;
      said = (said + chunk.toString("utf8")).slice(-4000);
      const match = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(said);
      if (match) {
        cdpPort = Number(match[1]);
        log(`chromium is running (start ${starts})`);
      }
    });
    chrome.on("error", (err) => log(`chromium could not be started: ${err.message}`));
    chrome.on("exit", (code, signal) => {
      cdpPort = 0;
      chrome = null;
      if (stopping) return;
      log(`chromium ended (${signal ?? code}); starting it again`);
      setTimeout(startChrome, Math.min(10_000, 500 * starts));
    });
  };
  startChrome();

  const fromChrome = (path) =>
    new Promise((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port: cdpPort, path, headers: { host: `127.0.0.1:${cdpPort}` }, timeout: 5000 }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", reject);
    });

  let refusedTokens = 0;
  const allowed = (url, headers) => {
    if (tokenMatches(tokenOf(url, headers), token)) return true;
    refusedTokens++;
    if (refusedTokens === 1 || refusedTokens % 100 === 0) log(`a request without the token was turned away (${refusedTokens} so far)`);
    return false;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://gate");
    if (req.method === "GET" && url.pathname === "/healthz") {
      return answer(res, cdpPort ? 200 : 503, { ok: Boolean(cdpPort) });
    }
    if (!allowed(url, req.headers)) {
      // A little later, so that guessing is slow.
      await new Promise((resolve) => setTimeout(resolve, 300));
      return answer(res, 401, { error: "The token is missing or wrong." });
    }
    if (req.method === "GET" && url.pathname === "/json/version") {
      if (!cdpPort) return answer(res, 503, { error: "Chromium is starting." });
      try {
        const version = await fromChrome("/json/version");
        const path = new URL(version.webSocketDebuggerUrl).pathname;
        return answer(res, 200, {
          Browser: version.Browser,
          "Protocol-Version": version["Protocol-Version"],
          "User-Agent": version["User-Agent"],
          webSocketDebuggerUrl: `ws://${req.headers.host ?? `127.0.0.1:${port}`}${path}`,
          gate: { version: GATE_VERSION, egress: "filtered", allowPrivate: allow, starts },
        });
      } catch {
        return answer(res, 503, { error: "Chromium does not answer." });
      }
    }
    return answer(res, 404, { error: "Not found." });
  });

  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => undefined);
    const url = new URL(req.url ?? "/", "http://gate");
    const reply = (status, text) => socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    if (!allowed(url, req.headers)) return void setTimeout(() => reply(401, "Unauthorized"), 300);
    if (!/^\/devtools\/browser\/[0-9a-f-]{8,64}$/i.test(url.pathname)) return reply(404, "Not Found");
    if (!cdpPort) return reply(503, "Service Unavailable");
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string" || String(req.headers.upgrade ?? "").toLowerCase() !== "websocket") return reply(400, "Bad Request");
    const upstream = net.connect({ host: "127.0.0.1", port: cdpPort });
    upstream.once("error", () => reply(502, "Bad Gateway"));
    upstream.once("connect", () => {
      // Without the token, and without an origin: as a program on this machine asks.
      upstream.write(
        `GET ${url.pathname} HTTP/1.1\r\nHost: 127.0.0.1:${cdpPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: ${req.headers["sec-websocket-version"] ?? "13"}\r\n\r\n`,
      );
      if (head.length > 0) upstream.write(head);
      socket.setTimeout(0);
      socket.setNoDelay(true);
      upstream.setNoDelay(true);
      link(socket, upstream);
    });
  });

  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close();
    proxy.server.close();
    if (chrome) chrome.kill("SIGTERM");
    setTimeout(() => {
      if (chrome) chrome.kill("SIGKILL");
      if (ownProfile) rmSync(profile, { recursive: true, force: true });
      process.exit(0);
    }, 1500).unref();
    if (!chrome) {
      if (ownProfile) rmSync(profile, { recursive: true, force: true });
      process.exit(0);
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  server.listen(port, host, () => {
    log(
      `browser gate ${GATE_VERSION} on ${host}:${port}; chromium: ${chromeBin}; ` +
        `pages may not reach private networks${allow.length ? `, except ${allow.join(", ")}` : ""}`,
    );
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`error: ${err?.message ?? err}`);
    process.exit(1);
  });
}
