#!/usr/bin/env node
// End-to-end checks of image and video generation, without a real provider.
//
//   npm run build
//   npm run test:e2e
//
// Starts the mock provider (mock-provider.mjs) and the built app, on a
// throwaway database in the system's temporary folder, runs checks.mjs
// against them and stops both. `./data` and `.env` are not used, and no real
// provider is called, so nothing is billed.
//
//   ONLY=images,videos,library,limits,projects   run some parts only
//   E2E_APP_PORT, E2E_MOCK_PORT, E2E_CDN_PORT     ports (3100, 4010, 4011)
//   KEEP=1                                        keep the temporary folder
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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
  child.once("exit", () => {
    proc.exited = true;
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

const mock = start("mock provider", [join(here, "mock-provider.mjs"), String(ports.mock), String(ports.cdn)], process.env);
running.push(mock);

// Everything the app reads is set here, so that a developer's own .env
// (which Next.js loads too, without replacing what is already set) has no say.
const app = start("app", [join(root, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(ports.app), "-H", HOST], {
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
  SANDBOX_URL: "",
  SANDBOX_TOKEN: "",
});
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

const checks = spawn(process.execPath, ["--import", "tsx", join(here, "checks.mjs")], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, E2E_APP_URL: appUrl, E2E_MOCK_URL: mockUrl, E2E_MEDIA_DIR: join(folder, "media") },
});
checks.once("exit", (code) => {
  if (code !== 0 && app.output.trim()) console.error(`\n── What the app logged\n${app.output}`);
  void finish(code ?? 1);
});
