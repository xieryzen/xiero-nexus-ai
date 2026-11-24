// Xiero Nexus AI: the runner.
//
// Runs one program on a copy of a set of files, in a folder that is made for
// it and thrown away afterwards, with a limit on its time and on what it may
// print, and hands back the packages it left behind. The app never runs code
// itself: it sends { files, command, timeoutMs } here and shows the result.
//
// This process does NOT isolate anything by itself. It belongs in a container
// that is the boundary (README.md): no rights of root for the programs, a
// read-only file system, limits on memory and processes, and a network that
// does not reach private addresses. scripts/host/runner-service.sh sets that
// up on a Pterodactyl node.
//
//   POST /run     { files: [{ path, content }], command, timeoutMs,
//                   keep?: [pattern], keepMaxFiles?, keepMaxFileBytes?,
//                   keepMaxTotalBytes?, stream? }
//                 -> { exitCode, stdout, stderr, durationMs, timedOut,
//                      kept: [{ path, base64 }], notKept: [{ path, reason }] }
//   GET  /health  -> { ok, protocol, ... }
//
// With "stream": true the answer starts at once and spaces are sent while
// the program runs, so that nothing between here and the app gives up on a
// build that says nothing for minutes; the JSON follows at the end. What goes
// wrong after that start is then in the JSON, as { error }.
//
// Settings, all from the environment:
//
//   PORT, HOST               where to listen (8080, 0.0.0.0)
//   RUNNER_TOKEN             the bearer token a request has to carry. Without
//                            one, anybody who reaches the port can run code.
//   WORK_BASE                where the folders of the runs are made (the
//                            temporary folder). Emptied of old runs at start.
//   RUNNER_MAX_SECONDS       the longest a program may run (120; 10 to 3600)
//   RUNNER_CONCURRENCY       how many programs run at once (1; up to 8). The
//                            others wait their turn.
//   RUNNER_QUEUE_SECONDS     how long a request waits for its turn (300)
//   RUNNER_RUN_AS            "uid:gid": the programs run as that user, not as
//                            the one this server runs as (which then has to be
//                            root). With more than one at once, the second
//                            runs as uid+1:gid+1, and so on: a program cannot
//                            touch this server or another run.
//   RUNNER_MAX_WORK_MB       the most a run's folder may hold (2048). A run
//                            that goes over is stopped.
//   RUNNER_MAX_BODY_MB       the largest request (64)
//   RUNNER_OUTPUT_CHARS      the most that is kept of what a program prints,
//                            for each of its two streams (200000): the start
//                            and the end, with the middle left out.
//   RUNNER_ALLOWED_COMMANDS  the programs that may be run, separated by
//                            commas. Without it, any program on the PATH: the
//                            app has its own list and checks before it asks.
//   RUNNER_CHILD_ENV         names of variables of this server's environment
//                            that the programs get too, separated by commas
//                            (JAVA_HOME, GRADLE_RO_DEP_CACHE, MAVEN_ARGS and a
//                            few more). The token is never one of them.
//   RUNNER_HOME_SKELETON     a folder whose content every run finds in its
//                            home: settings of build tools (/opt/runner/home
//                            when it exists).
//   RUNNER_SHARED_TMP        folders every program can write to, separated by
//                            colons (/tmp:/dev/shm): what a run left there is
//                            removed after it.

import http from "node:http";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { constants as FS, existsSync, readdirSync, readFileSync } from "node:fs";
import { chown, copyFile, lstat, mkdir, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const number = (name, fallback, min, max) => {
  const value = Number(process.env[name]);
  if (!process.env[name] || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), min), max);
};
const list = (name, fallback, separator = ",") =>
  (process.env[name] ?? fallback)
    .split(separator)
    .map((one) => one.trim())
    .filter(Boolean);

const PORT = number("PORT", 8080, 1, 65535);
const HOST = process.env.HOST || "0.0.0.0";
const TOKEN = process.env.RUNNER_TOKEN || "";
const WORK_BASE = process.env.WORK_BASE || tmpdir();
const MAX_SECONDS = number("RUNNER_MAX_SECONDS", 120, 10, 3600);
const CONCURRENCY = number("RUNNER_CONCURRENCY", 1, 1, 8);
const QUEUE_SECONDS = number("RUNNER_QUEUE_SECONDS", 300, 1, 3600);
const MAX_WORK_BYTES = number("RUNNER_MAX_WORK_MB", 2048, 16, 1024 * 1024) * 1024 * 1024;
const MAX_BODY_BYTES = number("RUNNER_MAX_BODY_MB", 64, 1, 1024) * 1024 * 1024;
const MAX_OUTPUT = number("RUNNER_OUTPUT_CHARS", 200_000, 1000, 5_000_000);
const ALLOWED = list("RUNNER_ALLOWED_COMMANDS", "");
const CHILD_ENV = list(
  "RUNNER_CHILD_ENV",
  "JAVA_HOME,GRADLE_RO_DEP_CACHE,GRADLE_OPTS,MAVEN_ARGS,MAVEN_OPTS,LANG,LC_ALL,TZ,NODE_OPTIONS,PIP_DISABLE_PIP_VERSION_CHECK,PIP_BREAK_SYSTEM_PACKAGES,NPM_CONFIG_UPDATE_NOTIFIER,NPM_CONFIG_FUND,NPM_CONFIG_AUDIT",
);
const SKELETON = process.env.RUNNER_HOME_SKELETON ?? (existsSync("/opt/runner/home") ? "/opt/runner/home" : "");
const SHARED_TMP = list("RUNNER_SHARED_TMP", "/tmp:/dev/shm", ":");

// The most this runner hands back, whatever a request asks for.
const KEEP_FILES_CAP = 50;
const KEEP_FILE_BYTES_CAP = 128 * 1024 * 1024;
const KEEP_TOTAL_BYTES_CAP = 256 * 1024 * 1024;
const KEEP_PATTERNS_CAP = 40;
// What is looked through for the files to hand back.
const WALK_ENTRIES_CAP = 50_000;
const WALK_DEPTH_CAP = 12;
const WALK_SKIPPED = new Set([".gradle", ".git", "node_modules", ".m2", ".kotlin"]);
const FILES_CAP = 5000;
const PROTOCOL = 2;

const SHELL_META = /[;&|<>`$(){}!#\n\r*?~]/;

// ─── Who the programs run as ─────────────────────────────────────────────────

/** The user of the first slot, or null when the programs run as this server does. */
const RUN_AS = (() => {
  const raw = (process.env.RUNNER_RUN_AS || "").trim();
  if (!raw) return null;
  const match = /^(\d{1,9}):(\d{1,9})$/.exec(raw);
  if (!match || Number(match[1]) === 0 || Number(match[2]) === 0) {
    console.error('error: RUNNER_RUN_AS is "uid:gid", and neither of them 0.');
    process.exit(1);
  }
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    console.error("error: RUNNER_RUN_AS is set, but this server is not root, so it cannot start a program as somebody else.");
    process.exit(1);
  }
  return { uid: Number(match[1]), gid: Number(match[2]) };
})();
const userOf = (slot) => (RUN_AS ? { uid: RUN_AS.uid + slot, gid: RUN_AS.gid + slot } : null);

// ─── Small things ────────────────────────────────────────────────────────────

function safePath(path) {
  if (typeof path !== "string" || !path || path.length > 512) return null;
  if (path.includes("\\") || path.includes("\0") || path.startsWith("/")) return null;
  const parts = path.split("/");
  for (const part of parts) if (part === "" || part === "." || part === "..") return null;
  return parts.join("/");
}

/**
 * Whether a path fits a pattern. `*` stands for any characters within one
 * folder, `**` for any folders, `?` for one character; everything else is
 * itself. The same rules as the app's (src/lib/result/kinds.ts).
 */
function patternToRegExp(pattern) {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          source += "(?:[^/]+/)*";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (ch === "?") {
      source += "[^/]";
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

function safePattern(raw) {
  if (typeof raw !== "string") return null;
  const pattern = raw.trim();
  if (!pattern || pattern.length > 200) return null;
  if (pattern.startsWith("/") || pattern.includes("\\") || pattern.split("/").some((part) => part === ".." || part === "." || part === "")) return null;
  if (!/^[A-Za-z0-9._\-/*? ]+$/.test(pattern)) return null;
  return pattern;
}

/** What a program printed, kept to its start and its end. */
function collector(max) {
  const headMax = Math.floor(max * 0.25);
  const tailMax = max - headMax;
  let head = "";
  let tail = "";
  let dropped = 0;
  return {
    add(chunk) {
      let text = chunk.toString("utf8");
      if (head.length < headMax) {
        const room = headMax - head.length;
        head += text.slice(0, room);
        text = text.slice(room);
      }
      if (!text) return;
      tail += text;
      if (tail.length > tailMax * 2) {
        dropped += tail.length - tailMax;
        tail = tail.slice(-tailMax);
      }
    },
    text() {
      let end = tail;
      let left = dropped;
      if (end.length > tailMax) {
        left += end.length - tailMax;
        end = end.slice(-tailMax);
      }
      return left > 0 ? `${head}\n[… ${left} characters are left out here …]\n${end}` : head + end;
    },
  };
}

function sameToken(given) {
  const a = Buffer.from(given);
  const b = Buffer.from(`Bearer ${TOKEN}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ─── Taking turns ────────────────────────────────────────────────────────────

const slots = Array.from({ length: CONCURRENCY }, () => false);
const waiting = [];

/** A slot to run in: at once, or when one is free. Rejects when the wait is over. */
function takeSlot(signal) {
  const free = slots.indexOf(false);
  if (free >= 0) {
    slots[free] = true;
    return Promise.resolve(free);
  }
  return new Promise((resolveSlot, reject) => {
    const entry = { resolveSlot, done: false };
    const leave = (why) => {
      if (entry.done) return;
      entry.done = true;
      clearTimeout(timer);
      const at = waiting.indexOf(entry);
      if (at >= 0) waiting.splice(at, 1);
      reject(new Error(why));
    };
    const timer = setTimeout(() => leave(`the runner was busy with other programs for ${QUEUE_SECONDS} seconds`), QUEUE_SECONDS * 1000);
    signal.addEventListener("abort", () => leave("the request was given up"), { once: true });
    entry.take = (slot) => {
      entry.done = true;
      clearTimeout(timer);
      resolveSlot(slot);
    };
    waiting.push(entry);
  });
}

function freeSlot(slot) {
  const next = waiting.shift();
  if (next) next.take(slot);
  else slots[slot] = false;
}

// ─── Stopping what a run started ─────────────────────────────────────────────

/** The processes of a user, from /proc: no program has to be started to find them. */
function processesOf(uid) {
  const found = [];
  let names;
  try {
    names = readdirSync("/proc");
  } catch {
    return found;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = readFileSync(`/proc/${name}/status`, "utf8");
      const line = /^Uid:\s+(\d+)/m.exec(status);
      if (line && Number(line[1]) === uid) found.push(Number(name));
    } catch {
      // It ended in the meantime.
    }
  }
  return found;
}

/**
 * Stop everything a run started: its process group, and, when it ran as a
 * user of its own, everything of that user. `run.done` says that the run is
 * over and its user may be another run's by now: nothing is stopped for a
 * run that is over.
 */
async function stopAll(child, user, run) {
  if (run?.done) return;
  // The group is known by the number of its first process, which is the
  // group's for as long as the process has not been buried. After that the
  // number may be somebody else's.
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // Gone already.
      }
    }
  }
  if (!user) return;
  for (let round = 0; round < 40; round++) {
    if (run?.done) return;
    const pids = processesOf(user.uid);
    if (pids.length === 0) return;
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Gone already.
      }
    }
    await new Promise((done) => setTimeout(done, 50));
  }
}

/** How much a folder holds, without following a link. Stops counting at the limit. */
async function sizeOf(dir, limit) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0 && total <= limit) {
    const at = stack.pop();
    let entries;
    try {
      entries = await readdir(at, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else {
        try {
          total += (await lstat(path)).blocks * 512;
        } catch {
          // Removed in the meantime.
        }
      }
    }
  }
  return total;
}

/** A folder's files and folders into another, without its links: the settings every run finds in its home. */
async function copyInto(from, to) {
  let entries;
  try {
    entries = await readdir(from, { withFileTypes: true });
  } catch {
    return;
  }
  await mkdir(to, { recursive: true });
  for (const entry of entries) {
    if (entry.isDirectory()) await copyInto(join(from, entry.name), join(to, entry.name));
    else if (entry.isFile()) await copyFile(join(from, entry.name), join(to, entry.name));
  }
}

/** What a user left in the folders every program can write to. */
async function sweepShared(user) {
  if (!user) return;
  for (const dir of SHARED_TMP) {
    let entries;
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const path = join(dir, name);
      try {
        if ((await lstat(path)).uid === user.uid) await rm(path, { recursive: true, force: true });
      } catch {
        // Gone, or not ours to remove.
      }
    }
  }
}

// ─── The files a program left behind ─────────────────────────────────────────

async function collectKept(root, input) {
  const patterns = (Array.isArray(input.keep) ? input.keep : [])
    .map(safePattern)
    .filter(Boolean)
    .slice(0, KEEP_PATTERNS_CAP)
    .map((pattern) => patternToRegExp(pattern));
  const kept = [];
  const notKept = [];
  if (patterns.length === 0) return { kept, notKept };
  const limit = (given, fallback, cap) => {
    const value = Number(given);
    return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), cap) : Math.min(fallback, cap);
  };
  const maxFiles = limit(input.keepMaxFiles, 12, KEEP_FILES_CAP);
  const maxFileBytes = limit(input.keepMaxFileBytes, 48 * 1024 * 1024, KEEP_FILE_BYTES_CAP);
  const maxTotalBytes = limit(input.keepMaxTotalBytes, 96 * 1024 * 1024, KEEP_TOTAL_BYTES_CAP);

  // The paths that fit, found without following a link: what a program made
  // is never trusted to point where it says.
  const fits = [];
  let seen = 0;
  const walk = async (dir, relative, depth) => {
    if (depth > WALK_DEPTH_CAP || seen > WALK_ENTRIES_CAP) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (++seen > WALK_ENTRIES_CAP) return;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!WALK_SKIPPED.has(entry.name)) await walk(join(dir, entry.name), path, depth + 1);
      } else if (entry.isFile() && patterns.some((pattern) => pattern.test(path))) {
        fits.push(path);
      }
    }
  };
  await walk(root, "", 0);

  let total = 0;
  for (const path of fits) {
    if (kept.length >= maxFiles) {
      notKept.push({ path, reason: `more than ${maxFiles} files` });
      continue;
    }
    let handle;
    try {
      handle = await open(join(root, path), FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile()) continue;
      if (stat.size > maxFileBytes) {
        notKept.push({ path, reason: `larger than ${Math.round(maxFileBytes / (1024 * 1024))} MB` });
        continue;
      }
      if (total + stat.size > maxTotalBytes) {
        notKept.push({ path, reason: `more than ${Math.round(maxTotalBytes / (1024 * 1024))} MB together` });
        continue;
      }
      const data = await handle.readFile();
      total += data.length;
      kept.push({ path, base64: data.toString("base64") });
    } catch {
      notKept.push({ path, reason: "it could not be read" });
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  return { kept, notKept };
}

// ─── One run ─────────────────────────────────────────────────────────────────

/** The programs that run now, for a server that is told to stop. */
const active = new Set();

class Refused extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** What a request asks for, checked. Throws Refused. */
function readRequest(body) {
  let input;
  try {
    input = JSON.parse(body);
  } catch {
    throw new Refused(400, "invalid json");
  }
  if (typeof input !== "object" || input === null) throw new Refused(400, "invalid json");
  const command = String(input.command || "").trim();
  if (!command || command.length > 4000 || SHELL_META.test(command)) throw new Refused(400, "invalid command");
  const argv = command.split(/\s+/);
  if (argv[0].includes("/") || argv[0].startsWith("-")) throw new Refused(400, "invalid command: a program is named, not a path");
  if (ALLOWED.length > 0 && !ALLOWED.includes(argv[0])) throw new Refused(400, `command not allowed: ${argv[0]}`);
  const files = Array.isArray(input.files) ? input.files : [];
  if (files.length > FILES_CAP) throw new Refused(400, `more than ${FILES_CAP} files`);
  const checked = [];
  for (const file of files) {
    const path = safePath(file?.path);
    if (path === null) throw new Refused(400, `invalid file path: ${String(file?.path).slice(0, 200)}`);
    checked.push({ path, content: String(file?.content ?? "") });
  }
  const timeoutMs = Math.min(Math.max(Number(input.timeoutMs) || 30_000, 1000), MAX_SECONDS * 1000);
  return { input, argv, files: checked, timeoutMs };
}

async function runOnce(request, slot, signal) {
  const { input, argv, files, timeoutMs } = request;
  const user = userOf(slot);
  const own = async (path) => {
    if (user) await chown(path, user.uid, user.gid);
  };
  const run = await mkdtemp(join(WORK_BASE, "run-"));
  const source = join(run, "src");
  const home = join(run, "home");
  const temp = join(run, "tmp");
  let child = null;
  const state = { done: false };
  try {
    // The folder of the run belongs to the user the program runs as, and
    // nobody else gets into it.
    const made = new Set([run]);
    for (const dir of [source, home, temp]) {
      await mkdir(dir, { recursive: true });
      made.add(dir);
    }
    if (SKELETON) await copyInto(SKELETON, home).catch(() => undefined);
    for (const file of files) {
      const absolute = resolve(source, file.path);
      if (absolute !== source && !absolute.startsWith(`${source}/`)) throw new Refused(400, "path escapes workspace");
      for (let dir = dirname(absolute); dir.length > source.length && !made.has(dir); dir = dirname(dir)) made.add(dir);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, file.content, "utf8");
      made.add(absolute);
    }
    if (user) {
      // Everything under the home came from the skeleton: all of it changes hands.
      const stack = [home];
      while (stack.length > 0) {
        const at = stack.pop();
        made.add(at);
        for (const entry of await readdir(at, { withFileTypes: true }).catch(() => [])) {
          const path = join(at, entry.name);
          if (entry.isDirectory()) stack.push(path);
          else made.add(path);
        }
      }
      for (const path of made) await own(path);
    }

    const env = {
      PATH: process.env.RUNNER_PATH || process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      HOME: home,
      TMPDIR: temp,
      CI: "1",
      GRADLE_USER_HOME: join(home, ".gradle"),
    };
    for (const name of CHILD_ENV) {
      if (name !== "RUNNER_TOKEN" && typeof process.env[name] === "string" && !(name in env)) env[name] = process.env[name];
    }

    const started = Date.now();
    const stdout = collector(MAX_OUTPUT);
    const stderr = collector(MAX_OUTPUT);
    let timedOut = false;
    let stoppedWhy = "";
    let spawnError = "";
    let endedBy = "";
    let exitCode = null;

    child = spawn(argv[0], argv.slice(1), {
      cwd: source,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // A group of its own: everything it starts is stopped with it.
      detached: true,
      ...(user ? { uid: user.uid, gid: user.gid } : {}),
    });
    active.add(child);
    child.stdout.on("data", (chunk) => stdout.add(chunk));
    child.stderr.on("data", (chunk) => stderr.add(chunk));

    // The program itself has ended, or could not be started.
    const exited = new Promise((resolveExit) => {
      child.once("error", (err) => {
        spawnError = err?.code === "ENOENT" ? `${argv[0]}: there is no such program here` : String(err?.message || err);
        resolveExit();
      });
      child.once("exit", (code, signal) => {
        exitCode = code;
        if (signal) endedBy = signal;
        // What it started in its group goes with it, now: while the number
        // of the group is still its own.
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // Nothing of it is left.
          }
        }
        resolveExit();
      });
    });
    // Everything it wrote has been read.
    const closed = new Promise((resolveClose) => child.once("close", resolveClose));
    const stop = (why) => {
      if (stoppedWhy) return;
      stoppedWhy = why;
      void stopAll(child, user, state);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop(`its time was up (${Math.round(timeoutMs / 1000)} s)`);
    }, timeoutMs);
    // A program that fills its folder is stopped: looked at every few seconds, one look at a time.
    let looking = false;
    const watch = setInterval(() => {
      if (looking) return;
      looking = true;
      sizeOf(run, MAX_WORK_BYTES)
        .then((bytes) => {
          if (bytes > MAX_WORK_BYTES) stop(`it filled its folder: more than ${Math.round(MAX_WORK_BYTES / (1024 * 1024))} MB`);
        })
        .catch(() => undefined)
        .finally(() => {
          looking = false;
        });
    }, 3000);
    const onAbort = () => stop("the request was given up");
    signal.addEventListener("abort", onAbort, { once: true });

    await exited;
    clearTimeout(timer);
    clearInterval(watch);
    signal.removeEventListener("abort", onAbort);
    // Whatever it left running goes before its files are looked at: nothing
    // changes them under the reader, and nothing holds its output open.
    await stopAll(child, user, state);
    if (!spawnError) {
      // Its last words are waited for, but not for as long as something keeps them open.
      let giveUp = null;
      await Promise.race([closed, new Promise((resolveWait) => (giveUp = setTimeout(resolveWait, 3000)))]);
      clearTimeout(giveUp);
    }
    child.stdout.destroy();
    child.stderr.destroy();

    let errText = stderr.text();
    if (spawnError) errText += `${errText ? "\n" : ""}[runner] ${spawnError}`;
    if (stoppedWhy) errText += `${errText ? "\n" : ""}[runner] The program was stopped: ${stoppedWhy}.`;
    else if (endedBy) {
      errText +=
        `${errText ? "\n" : ""}[runner] The program was ended by ${endedBy}` +
        (endedBy === "SIGKILL" ? ": by the system, most likely because it used more memory than the runner has." : ".");
    }
    const handed = stoppedWhy || exitCode === null ? { kept: [], notKept: [] } : await collectKept(source, input);
    return {
      exitCode: stoppedWhy || spawnError ? null : exitCode,
      stdout: stdout.text(),
      stderr: errText,
      durationMs: Date.now() - started,
      timedOut,
      kept: handed.kept,
      notKept: handed.notKept,
    };
  } finally {
    if (child) active.delete(child);
    await stopAll(child, user, state).catch(() => undefined);
    // From here on the run is over: its user may be the next run's, and
    // nothing that was started for this run stops anything any more.
    state.done = true;
    await rm(run, { recursive: true, force: true }).catch(() => undefined);
    await sweepShared(user).catch(() => undefined);
  }
}

// ─── The server ──────────────────────────────────────────────────────────────

let running = 0;

function send(res, code, body) {
  if (res.headersSent) {
    res.end(JSON.stringify(body));
    return;
  }
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function handleRun(req, res, body) {
  let request;
  try {
    request = readRequest(body);
  } catch (err) {
    return send(res, err instanceof Refused ? err.status : 400, { error: String(err?.message || err) });
  }
  const stream = request.input.stream === true;
  const gone = new AbortController();
  res.once("close", () => {
    if (!res.writableEnded) gone.abort();
  });
  let beat = null;
  if (stream) {
    // The answer starts now; a space now and then says that this end is still there.
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "x-accel-buffering": "no" });
    res.write(" ");
    beat = setInterval(() => res.write(" "), 10_000);
  }
  let slot = -1;
  try {
    slot = await takeSlot(gone.signal);
    running++;
    const result = await runOnce(request, slot, gone.signal);
    send(res, 200, result);
  } catch (err) {
    const status = err instanceof Refused ? err.status : slot < 0 ? 503 : 500;
    send(res, status, { error: String(err?.message || err) });
  } finally {
    if (beat) clearInterval(beat);
    if (slot >= 0) {
      running--;
      freeSlot(slot);
    }
  }
}

const server = http.createServer((req, res) => {
  const path = (req.url || "").split("?")[0];
  if (req.method === "GET" && (path === "/health" || path === "/healthz")) {
    return send(res, 200, {
      ok: true,
      protocol: PROTOCOL,
      keeps: true,
      stream: true,
      maxSeconds: MAX_SECONDS,
      slots: CONCURRENCY,
      running,
      waiting: waiting.length,
      // Whether a program runs as somebody else than this server.
      separate: RUN_AS !== null,
    });
  }
  if (req.method === "POST" && path === "/run") {
    if (TOKEN && !sameToken(String(req.headers["authorization"] || ""))) {
      req.resume();
      return send(res, 401, { error: "unauthorized" });
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return send(res, 413, { error: `the request is larger than ${Math.round(MAX_BODY_BYTES / (1024 * 1024))} MB` });
      handleRun(req, res, Buffer.concat(chunks).toString("utf8")).catch((err) => send(res, 500, { error: String(err?.message || err) }));
    });
    return;
  }
  send(res, 404, { error: "not found" });
});
// A build takes as long as it takes: the limits are the program's own.
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 5000;

async function start() {
  // What an earlier start left behind, when it was stopped in the middle of a run.
  try {
    for (const name of await readdir(WORK_BASE)) {
      if (name.startsWith("run-")) await rm(join(WORK_BASE, name), { recursive: true, force: true }).catch(() => undefined);
    }
  } catch {
    await mkdir(WORK_BASE, { recursive: true }).catch(() => undefined);
  }
  if (!TOKEN) console.warn("warning: RUNNER_TOKEN is not set: whoever reaches this port can run programs here.");
  server.listen(PORT, HOST, () => {
    console.log(
      `xiero-nexus runner on ${HOST}:${PORT}: ${CONCURRENCY} at once, up to ${MAX_SECONDS} s each` +
        (RUN_AS ? `, programs run as ${RUN_AS.uid}:${RUN_AS.gid}${CONCURRENCY > 1 ? " and the next ones up" : ""}` : ", programs run as this server does"),
    );
  });
}

for (const name of ["SIGTERM", "SIGINT"]) {
  process.once(name, () => {
    server.close();
    for (const child of active) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Gone already.
      }
    }
    for (let slot = 0; slot < CONCURRENCY; slot++) {
      const user = userOf(slot);
      if (!user) continue;
      for (const pid of processesOf(user.uid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Gone already.
        }
      }
    }
    setTimeout(() => process.exit(0), 200).unref();
  });
}

void start();
