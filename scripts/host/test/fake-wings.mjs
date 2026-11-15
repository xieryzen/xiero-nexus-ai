#!/usr/bin/env node
// A stand-in for Wings, and for the server's container, in the tests of the
// host scripts. It "runs" a server by starting the bundle in its folder as a
// plain process, and follows Wings (router/, server/power.go, server/crash.go
// and environment/docker/power.go of pterodactyl/wings 1.12) where the scripts
// depend on it:
//
//   - the paths, the status codes and the order of the fields in the answers;
//   - a power request is answered with 202 at once and carried out afterwards;
//   - one power action at a time: a second one waits only as long as its
//     wait_seconds says and is dropped otherwise, except "kill";
//   - before a start the server is still "offline" for a while, and it stays
//     "starting" for as long as it runs;
//   - a server whose process ends by itself is started again, unless that
//     happened less than a minute ago too.
//
//   node fake-wings.mjs <port> <volumes folder> <token> <app port> [releases folder]
//
// Test controls, without a token:
//   POST /__control/<uuid>   {"ignoreStop": true, "suspended": true, "preboot": 12000}
//   GET  /__state/<uuid>     {"running": true, "state": "starting", "starts": 2, "startedAt": "…", "daemon": […]}
//   GET  /__log/<uuid>       the console output
//   GET  /__requests         what Wings was asked: ["GET /api/servers", …]
//   GET  /releases/…         files of the releases folder
import { spawn } from "node:child_process";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join, normalize } from "node:path";

const [port, volumes, token, appPort, releases] = process.argv.slice(2);
if (!port || !volumes || !token || !appPort) {
  console.error("usage: fake-wings.mjs <port> <volumes folder> <token> <app port> [releases folder]");
  process.exit(2);
}

// How long a server takes before its process starts: Wings first asks the
// panel for the server's settings, measures its disk use and fixes the owner
// of its files. All that time it still reports the server as "offline".
const PREBOOT_MS = Number(process.env.FAKE_WINGS_PREBOOT_MS ?? 1200);
// Wings does not restart a server that crashes twice within this time.
const CRASH_TIMEOUT_MS = 60_000;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const servers = new Map();
function server(uuid) {
  if (!existsSync(join(volumes, uuid))) return null;
  if (!servers.has(uuid)) {
    servers.set(uuid, { state: "offline", child: null, log: [], daemon: [], starts: 0, startedAt: "0001-01-01T00:00:00Z", lock: false, lastCrash: 0, ignoreStop: false, suspended: false, preboot: PREBOOT_MS });
  }
  return servers.get(uuid);
}

const note = (s, text) => {
  s.daemon.push(text);
  if (s.daemon.length > 100) s.daemon.shift();
};

// Wings calls a move from "starting" or "running" straight to "offline" a
// crash; a stop goes through "stopping" first.
function setState(uuid, s, next) {
  const previous = s.state;
  s.state = next;
  if ((previous === "starting" || previous === "running") && next === "offline") void crashed(uuid, s);
}

async function crashed(uuid, s) {
  note(s, "---------- Detected server process in a crashed state! ----------");
  if (s.lastCrash && Date.now() - s.lastCrash < CRASH_TIMEOUT_MS) {
    note(s, "Aborting automatic restart, last crash occurred less than 60 seconds ago.");
    return;
  }
  s.lastCrash = Date.now();
  await power(uuid, s, "start", 0);
}

// One power action at a time for a server. "kill" goes through at once. Any
// other action waits for the one in progress for wait_seconds, and without
// wait_seconds it is dropped: the request was answered with 202 long before.
async function power(uuid, s, action, waitSeconds) {
  if (action === "kill") return terminate(uuid, s);
  const deadline = Date.now() + waitSeconds * 1000;
  while (s.lock) {
    if (Date.now() >= deadline) return note(s, `dropped "${action}": another power action is in progress`);
    await sleep(50);
  }
  s.lock = true;
  try {
    if (action === "start") {
      if (s.state !== "offline") return;
      await boot(uuid, s);
    } else {
      await waitForStop(uuid, s);
      if (action === "restart") await boot(uuid, s);
    }
  } finally {
    s.lock = false;
  }
}

async function boot(uuid, s) {
  await sleep(s.preboot);
  if (s.suspended || s.child) return;
  setState(uuid, s, "starting");
  s.log = [];
  s.starts += 1;
  s.startedAt = new Date().toISOString();
  const folder = join(volumes, uuid);
  const entry = existsSync(join(folder, "xiero-nexus-ai", "start.js")) ? "xiero-nexus-ai/start.js" : "start.js";
  const child = spawn(process.execPath, [entry], {
    cwd: folder,
    // What a container gets: its own home and the port the panel assigned.
    env: { PATH: process.env.PATH, HOME: folder, SERVER_PORT: String(appPort), BIND_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const keep = (chunk) => {
    for (const line of String(chunk).split("\n")) if (line.trim()) s.log.push(line);
    if (s.log.length > 200) s.log.splice(0, s.log.length - 200);
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  child.once("exit", () => {
    if (s.child === child) s.child = null;
    setState(uuid, s, "offline");
  });
  s.child = child;
  // A generic Node.js egg has no line to tell that the app is up, so the
  // server stays "starting" for as long as it runs.
}

// The stop of the egg (here: Ctrl+C), then wait until the process is gone.
async function waitForStop(uuid, s) {
  if (s.state !== "offline") setState(uuid, s, "stopping");
  if (s.child && !s.ignoreStop) s.child.kill("SIGINT");
  while (s.child) await sleep(50);
  setState(uuid, s, "offline");
}

function terminate(uuid, s) {
  if (s.child) {
    setState(uuid, s, "stopping");
    s.child.kill("SIGKILL");
  }
  setState(uuid, s, "offline");
}

function send(res, status, body) {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

async function readJson(req) {
  let text = "";
  for await (const chunk of req) text += chunk;
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}

// What Wings was asked, for a test that wants to know that nothing was changed.
const requests = [];

const http = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts[0] === "releases" && releases) {
    const file = normalize(join(releases, ...parts.slice(1)));
    if (!file.startsWith(normalize(releases)) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: "not found" });
    res.writeHead(200, { "content-type": "application/octet-stream" });
    return void createReadStream(file).pipe(res);
  }
  if (parts[0] === "__control" || parts[0] === "__state" || parts[0] === "__log") {
    const s = server(parts[1] ?? "");
    if (!s) return send(res, 404, { error: "no such server" });
    if (parts[0] === "__control") {
      const wanted = await readJson(req);
      for (const key of ["ignoreStop", "suspended", "preboot"]) if (key in wanted) s[key] = wanted[key];
    }
    if (parts[0] === "__log") {
      res.writeHead(200, { "content-type": "text/plain" });
      return void res.end(s.log.join("\n") + "\n");
    }
    return send(res, 200, { running: Boolean(s.child), state: s.state, starts: s.starts, startedAt: s.startedAt, daemon: s.daemon });
  }

  if (parts[0] === "__requests") return send(res, 200, requests);

  // Everything else is Wings itself, which wants the node's token.
  requests.push(`${req.method} ${url.pathname}`);
  if (requests.length > 500) requests.shift();
  const given = (req.headers.authorization ?? "").split(" ");
  if (given.length !== 2 || given[0] !== "Bearer") return send(res, 401, { error: "The required authorization heads were not present in the request." });
  if (given[1] !== token) return send(res, 403, { error: "You are not authorized to access this endpoint." });

  if (parts[0] !== "api" || parts[1] !== "servers") return send(res, 404, { error: "not found" });
  const describe = (uuid, s) => ({
    state: s.state,
    is_suspended: s.suspended,
    utilization: { memory_bytes: 0, memory_limit_bytes: 0, cpu_absolute: 0, network: { rx_bytes: 0, tx_bytes: 0 }, uptime: 0, state: s.state, disk_bytes: 0 },
    configuration: {
      uuid,
      meta: { name: `Customer server ${uuid.slice(0, 4)}`, description: "" },
      suspended: s.suspended,
      invocation: "node xiero-nexus-ai/start.js",
      skip_egg_scripts: false,
      environment: { STARTUP: "node xiero-nexus-ai/start.js", P_SERVER_UUID: uuid, NOTE: 'a value with "state":"running" and "is_suspended":true in it' },
      labels: {},
      allocations: { force_outgoing_ip: false, default: { ip: "0.0.0.0", port: Number(appPort) }, mappings: { "0.0.0.0": [Number(appPort)] } },
      build: { memory_limit: 1024, swap: 0, io_weight: 500, cpu_limit: 0, disk_space: 5120, threads: "" },
      crash_detection_enabled: true,
      mounts: [],
      egg: { id: "00000000-0000-0000-0000-000000000000", file_denylist: [] },
      container: { image: "ghcr.io/parkervcp/yolks:nodejs_22" },
    },
  });
  if (req.method === "GET" && parts.length === 2) {
    // Every server Wings has. A folder named in FAKE_WINGS_UNKNOWN is a
    // leftover: its files are there, but Wings has no such server.
    const unknown = new Set((process.env.FAKE_WINGS_UNKNOWN ?? "").split(",").filter(Boolean));
    const all = readdirSync(volumes, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !unknown.has(entry.name))
      .map((entry) => describe(entry.name, server(entry.name)));
    return send(res, 200, all);
  }
  const uuid = parts[2];
  const s = server(uuid);
  if (!s) return send(res, 404, { error: "The requested resource does not exist on this instance." });

  if (req.method === "GET" && parts.length === 3) return send(res, 200, describe(uuid, s));
  if (req.method === "GET" && parts[3] === "logs") {
    const size = Math.min(Number(url.searchParams.get("size")) || 100, 100);
    return send(res, 200, { data: s.log.slice(-size) });
  }
  if (req.method === "POST" && parts[3] === "power") {
    const { action, wait_seconds: wait } = await readJson(req);
    if (!["start", "stop", "restart", "kill"].includes(action)) {
      return send(res, 422, { error: 'The power action provided was not valid, should be one of "stop", "start", "restart", "kill"' });
    }
    if ((action === "start" || action === "restart") && s.suspended) return send(res, 400, { error: "Cannot start or restart a server that is suspended." });
    // Like Wings: accepted at once, done afterwards, and nobody is told how it went.
    res.writeHead(202);
    res.end();
    const waitSeconds = Number.isInteger(wait) ? (wait < 0 || wait > 300 ? 30 : wait) : 0;
    void power(uuid, s, action, waitSeconds);
    return;
  }
  return send(res, 404, { error: "not found" });
});

function shutdown() {
  for (const s of servers.values()) s.child?.kill("SIGKILL");
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
http.listen(Number(port), "127.0.0.1", () => console.log(`fake wings on ${port}`));
