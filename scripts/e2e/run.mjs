#!/usr/bin/env node
// End-to-end checks of the whole app, without a real provider.
//
//   npm run build
//   npm run test:e2e
//
// Starts the mock provider (mock-provider.mjs) and the built app, on a
// throwaway database in the system's temporary folder, runs checks.mjs
// against them and stops both. `./data` and `.env` are not used, and no real
// provider is called, so nothing is billed.
//
// The last part is done here and not in checks.mjs, because it needs the
// server to go away: the app is told to stop while a page follows a run, and
// is started again on the same database.
//
//   ONLY=images,videos,library,limits,projects   run some parts only
//   ONLY=speech,render,knowledge,tools,runs,notifications,api,adapters,reel
//   E2E_APP_PORT, E2E_MOCK_PORT, E2E_CDN_PORT     ports (3100, 4010, 4011)
//   KEEP=1                                        keep the temporary folder
//   FFMPEG_PATH=<program>                         the ffmpeg to join clips with
//   E2E_BROWSER=<folder>                          also click through the dashboard
//                                                 in a headless browser; see
//                                                 browser-checks.mjs
//
// Joining clips needs ffmpeg. With one on this machine (FFMPEG_PATH, or
// `ffmpeg` on the PATH) those checks run for real; without, they check that
// the app says what is missing.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const HOST = "127.0.0.1";

const ports = {
  app: Number(process.env.E2E_APP_PORT ?? 3100),
  mock: Number(process.env.E2E_MOCK_PORT ?? 4010),
  cdn: Number(process.env.E2E_CDN_PORT ?? 4011),
};

function fail(message) {
  console.error(`test:e2e: ${message}`);
  process.exit(1);
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, HOST);
  });
}

/** Start a Node.js script; its output is kept, to show if something goes wrong. */
function start(name, args, env) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  const proc = { name, child, output: "", exited: false };
  const keep = (data) => {
    proc.output = (proc.output + data.toString()).slice(-8000);
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  child.once("exit", (code, signal) => {
    proc.exited = true;
    proc.code = code;
    proc.signal = signal;
  });
  return proc;
}

function stop(proc) {
  return new Promise((resolve) => {
    if (proc.exited) return resolve();
    const force = setTimeout(() => proc.child.kill("SIGKILL"), 5000);
    proc.child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    proc.child.kill();
  });
}

/** Wait until `url` answers, or until `proc` has exited. */
async function ready(proc, url, seconds = 60) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (proc.exited) return false;
    try {
      const res = await fetch(url, { redirect: "manual" });
      await res.arrayBuffer();
      if (res.status < 500) return true;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

if (!existsSync(join(root, ".next", "BUILD_ID"))) fail("there is no build to test. Run `npm run build` first.");
for (const [name, port] of Object.entries(ports)) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`the ${name} port is not a port number.`);
  if (!(await portIsFree(port))) {
    fail(`port ${port} is in use. Choose another with E2E_${name.toUpperCase()}_PORT=<port>.`);
  }
}

const folder = await mkdtemp(join(tmpdir(), "xiero-nexus-e2e-"));
const running = [];
let stopping = false;

async function finish(code) {
  if (stopping) return;
  stopping = true;
  await Promise.all(running.map(stop));
  if (process.env.KEEP === "1") console.log(`\nKept ${folder}`);
  else await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  process.exit(code);
}
process.on("SIGINT", () => void finish(130));
process.on("SIGTERM", () => void finish(143));

// ffmpeg, when this machine has one: a real two-second clip for the mock to
// serve, so that the app has something to join. Its sound ends a little
// before its picture: every ffmpeg version then reads the file as two seconds
// long. (With sound of the same length, old versions read 2.02 seconds.)
const ffmpeg = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
const sample = join(folder, "sample.mp4");
const made = spawnSync(
  ffmpeg,
  [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=360x640:rate=24:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1.9",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", sample,
  ],
  { stdio: "ignore" },
);
const hasFfmpeg = made.status === 0 && existsSync(sample);
if (!hasFfmpeg) console.log("test:e2e: no usable ffmpeg here: joining clips is checked for its error message only.");

const mock = start("mock provider", [join(here, "mock-provider.mjs"), String(ports.mock), String(ports.cdn)], {
  ...process.env,
  ...(hasFfmpeg ? { SAMPLE_VIDEO: sample } : {}),
});
running.push(mock);

// Everything the app reads is set here, so that a developer's own .env
// (which Next.js loads too, without replacing what is already set) has no say.
const appEnv = {
  ...process.env,
  NODE_ENV: "production",
  NEXT_TELEMETRY_DISABLED: "1",
  DATABASE_PATH: join(folder, "nexus.db"),
  MEDIA_PATH: "",
  SECRET_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  COOKIE_SECURE: "false",
  APP_URL: `http://${HOST}:${ports.app}`,
  // The mock is on this machine: allow it as a provider address.
  ALLOW_PRIVATE_PROVIDER_HOSTS: HOST,
  // The first account the checks register has to become the administrator.
  BOOTSTRAP_ADMIN_USERNAME: "",
  BOOTSTRAP_ADMIN_EMAIL: "",
  BOOTSTRAP_ADMIN_PASSWORD: "",
  // The mock also plays the sandbox runner, the search service and the
  // webhook receiver. They are on this machine, so its address is allowed.
  SANDBOX_URL: `http://${HOST}:${ports.mock}/sandbox`,
  SANDBOX_TOKEN: "sandbox-mock-token",
  SANDBOX_ALLOWED_COMMANDS: "",
  SEARCH_PROVIDER: "brave",
  SEARCH_URL: `http://${HOST}:${ports.mock}/search/res/v1/web/search`,
  SEARCH_API_KEY: "BSA-mock-search-key-0123456789",
  AGENT_HTTP_ALLOWED_HOSTS: "",
  AGENT_HTTP_PRIVATE_HOSTS: HOST,
  ALLOW_PRIVATE_WEBHOOK_HOSTS: HOST,
  // A program that does not exist: the app then reports that ffmpeg is missing.
  FFMPEG_PATH: hasFfmpeg ? ffmpeg : join(folder, "no-ffmpeg-here"),
  SUBTITLE_FONT_FILE: "",
  SUBTITLE_FONT_NAME: "",
  RUN_CONCURRENCY: "",
  NEXUS_WORKER: "",
};
const startApp = () =>
  start("app", [join(root, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(ports.app), "-H", HOST], appEnv);
let app = startApp();
running.push(app);

const appUrl = `http://${HOST}:${ports.app}`;
const mockUrl = `http://${HOST}:${ports.mock}`;
for (const [proc, url] of [
  [mock, `${mockUrl}/__log`],
  [app, `${appUrl}/login`],
]) {
  if (!(await ready(proc, url))) {
    console.error(`test:e2e: the ${proc.name} did not start.\n${proc.output}`);
    await finish(1);
  }
}

const checkEnv = {
  ...process.env,
  E2E_APP_URL: appUrl,
  E2E_MOCK_URL: mockUrl,
  E2E_CDN_URL: `http://${HOST}:${ports.cdn}`,
  E2E_MEDIA_DIR: join(folder, "media"),
  // Some checks change the database directly: to make a schedule due now,
  // and to leave a run the way a stopped server would.
  E2E_DB_PATH: join(folder, "nexus.db"),
  E2E_FFMPEG: hasFfmpeg ? "1" : "",
  // The checks decode the joined videos with it, to see what the files hold.
  E2E_FFMPEG_PATH: hasFfmpeg ? ffmpeg : "",
};

/** Run one of the check scripts and resolve with its exit code. */
function runChecks(args, env = checkEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit", env });
    child.once("error", () => resolve(1));
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

let code = await runChecks(["--import", "tsx", join(here, "checks.mjs")]);

// The browser pass uses what the checks left in the database, so it only
// makes sense after all of them ran.
const browserModules = process.env.E2E_BROWSER?.trim();
if (browserModules && code === 0) {
  if (process.env.ONLY) {
    console.log("\ntest:e2e: the browser checks need the whole run; skipped because ONLY is set.");
  } else {
    code = await runChecks([join(here, "browser-checks.mjs")], { ...checkEnv, BROWSER_MODULES: browserModules });
  }
}

// ── Stopping and starting again ──────────────────────────────────────────────

/**
 * Tell the app to stop while a page follows a run, and start it again. This
 * is what an upgrade does to a server that is busy.
 */
async function stopAndStartAgain() {
  let failed = 0;
  let passed = 0;
  const check = (name, condition, detail) => {
    if (condition) passed++;
    else failed++;
    console.log(`  ${condition ? "ok  " : "FAIL"} ${name}${condition || detail === undefined ? "" : `  →  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const json = { "content-type": "application/json" };
  const Database = createRequire(import.meta.url)("better-sqlite3");
  const lastRun = (projectId) => {
    const db = new Database(appEnv.DATABASE_PATH, { readonly: true, timeout: 5000 });
    try {
      return db.prepare("SELECT id, status, heartbeat_at AS heartbeatAt, resumes FROM project_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1").get(projectId);
    } finally {
      db.close();
    }
  };

  console.log("\n── Stopping: the server ends when it is told to, and the next start goes on with its runs");
  // The administrator and the project that checks.mjs left behind.
  const login = await fetch(`${appUrl}/api/auth/login`, { method: "POST", headers: json, body: JSON.stringify({ identifier: "admin", password: "correct-horse-battery" }) });
  const cookie = (login.headers.getSetCookie?.() ?? []).map((line) => line.split(";")[0]).find((pair) => pair.startsWith("nexus_session="));
  const list = cookie ? await (await fetch(`${appUrl}/api/projects`, { headers: { cookie } })).json().catch(() => null) : null;
  const project = list?.projects?.find((p) => p.title === "Detach");
  if (!project) {
    check("the project of the earlier checks is there to run", false, { signedIn: Boolean(cookie), projects: list?.projects?.map((p) => p.title) });
    return 1;
  }
  await fetch(`${mockUrl}/__reset`).catch(() => undefined);

  // A page starts a run and keeps following it.
  const following = await fetch(`${appUrl}/api/projects/${project.id}/run`, { method: "POST", headers: { ...json, cookie }, body: "{}" });
  const reader = following.body.getReader();
  await reader.read();
  const stream = (async () => {
    try {
      for (;;) if ((await reader.read()).done) return "ended";
    } catch {
      return "cut";
    }
  })();
  check("a run is in progress, with a page following it", following.status === 200 && lastRun(project.id)?.status === "running", [following.status, lastRun(project.id)]);

  const stopped = app;
  const askedAt = Date.now();
  const gone = new Promise((resolve) => stopped.child.once("exit", resolve));
  stopped.child.kill("SIGTERM");
  await Promise.race([gone, sleep(10_000)]);
  const took = Date.now() - askedAt;
  check("told to stop, the server ends by itself within 5 seconds, although the page is still connected", stopped.exited && took < 5000, { exited: stopped.exited, ms: took });
  check("  it ends cleanly", stopped.code === 0 && stopped.signal === null, { code: stopped.code, signal: stopped.signal });
  check("  it says what happens to the run", /stopping\. 1 run in progress will be picked up again at the next start/.test(stopped.output), stopped.output.slice(-300));
  check("  the page's connection ends", (await Promise.race([stream, sleep(3000).then(() => "still open")])) !== "still open");
  if (!stopped.exited) await stop(stopped);
  const left = lastRun(project.id);
  check("the run is left as in progress, handed back for the next start to take", left?.status === "running" && left.heartbeatAt === null, left);

  // The same database, a new process.
  running.splice(running.indexOf(stopped), 1);
  app = startApp();
  running.push(app);
  const startedAt = Date.now();
  if (!(await ready(app, `${appUrl}/login`))) {
    check("the server starts again", false, app.output.slice(-600));
    return 1;
  }
  let run = lastRun(project.id);
  // Without the hand-over a run is only taken over when nothing was heard of
  // its process for a minute.
  while (run?.status === "running" && Date.now() - startedAt < 45_000) {
    await sleep(500);
    run = lastRun(project.id);
  }
  check("started again, the server picks the run up at once and finishes it", run?.status === "succeeded" && run.resumes === left?.resumes + 1, { run, seconds: Math.round((Date.now() - startedAt) / 1000) });
  const after = await (await fetch(`${appUrl}/api/projects/${project.id}`, { headers: { cookie } })).json().catch(() => null);
  check("  every task of the project is done, and the session is still good", after?.project?.status === "succeeded" && after.project.tasks?.every((t) => t.status === "succeeded"), [after?.project?.status, after?.project?.tasks?.map((t) => t.status), after?.error]);
  const videos = (await (await fetch(`${mockUrl}/__log`)).json().catch(() => [])).filter((l) => l.method === "POST" && /\/videos$/.test(l.path)).length;
  check("  the video that was being generated is not ordered a second time", videos === 1, videos);

  console.log(`\n${passed} passed, ${failed} failed (stopping and starting again)`);
  return failed === 0 ? 0 : 1;
}

if (code === 0 && !process.env.ONLY) code = await stopAndStartAgain();

if (code !== 0 && app.output.trim()) console.error(`\n── What the app logged\n${app.output}`);
await finish(code);
