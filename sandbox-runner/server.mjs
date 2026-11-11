// Xiero Nexus AI — reference sandbox runner.
//
// Runs a single allowlisted program against a set of files in an ephemeral
// working directory, with a timeout and capped output. This process does NOT
// provide isolation by itself — run it inside a locked-down container:
//
//   docker run --rm -p 8080:8080 \
//     --network none --memory 512m --cpus 1 --pids-limit 128 \
//     --read-only --tmpfs /work:exec,size=256m --user 10001:10001 \
//     -e RUNNER_TOKEN=... xiero-nexus-sandbox
//
// The container is the security boundary (no network, resource caps, ephemeral
// FS). This server adds: argv-only execution (no shell), timeout, output caps.

import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.RUNNER_TOKEN || "";
const MAX_OUTPUT = 100_000;
const MAX_TIMEOUT = 120_000;
const WORK_BASE = process.env.WORK_BASE || tmpdir();

const SHELL_META = /[;&|<>`$(){}!#\n\r*?~]/;

function safeSegment(path) {
  if (typeof path !== "string" || !path || path.length > 256) return null;
  if (path.includes("\\") || path.startsWith("/")) return null;
  const segs = path.split("/");
  for (const s of segs) if (s === "" || s === "." || s === "..") return null;
  return segs.join("/");
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(body);
}

async function handleRun(req, res, body) {
  if (TOKEN) {
    const auth = req.headers["authorization"] || "";
    if (auth !== `Bearer ${TOKEN}`) return send(res, 401, { error: "unauthorized" });
  }
  let input;
  try {
    input = JSON.parse(body);
  } catch {
    return send(res, 400, { error: "invalid json" });
  }
  const command = String(input.command || "");
  if (!command || SHELL_META.test(command)) return send(res, 400, { error: "invalid command" });
  const argv = command.trim().split(/\s+/);
  const timeoutMs = Math.min(Math.max(Number(input.timeoutMs) || 30000, 1000), MAX_TIMEOUT);
  const files = Array.isArray(input.files) ? input.files : [];

  const dir = await mkdtemp(join(WORK_BASE, "run-"));
  try {
    for (const f of files) {
      const rel = safeSegment(f?.path);
      if (rel === null) return send(res, 400, { error: `invalid file path: ${f?.path}` });
      const abs = resolve(dir, rel);
      if (abs !== dir && !abs.startsWith(dir + "/")) return send(res, 400, { error: "path escapes workspace" });
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, String(f?.content ?? ""), "utf8");
    }

    const started = Date.now();
    const child = spawn(argv[0], argv.slice(1), {
      cwd: dir,
      env: { PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin", HOME: dir, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { if (stdout.length < MAX_OUTPUT) stdout += d.toString(); });
    child.stderr.on("data", (d) => { if (stderr.length < MAX_OUTPUT) stderr += d.toString(); });

    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const exitCode = await new Promise((resolveExit) => {
      child.on("error", (e) => { stderr += `\n[spawn error] ${e.message}`; resolveExit(null); });
      child.on("close", (code) => resolveExit(code));
    });
    clearTimeout(timer);

    send(res, 200, {
      exitCode,
      stdout: stdout.slice(0, MAX_OUTPUT),
      stderr: stderr.slice(0, MAX_OUTPUT),
      durationMs: Date.now() - started,
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });
  if (req.method === "POST" && req.url === "/run") {
    let body = "";
    req.on("data", (d) => {
      body += d;
      if (body.length > 20_000_000) req.destroy();
    });
    req.on("end", () => handleRun(req, res, body).catch((e) => send(res, 500, { error: String(e?.message || e) })));
    return;
  }
  send(res, 404, { error: "not found" });
});

const HOST = process.env.HOST || "0.0.0.0";
server.listen(PORT, HOST, () => console.log(`xiero-nexus sandbox runner on ${HOST}:${PORT}`));
