import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { KEEP_DEFAULT, keepPatterns, matchesPattern } from "../src/lib/result/kinds";
import { readKept } from "../src/lib/workspace/kept";

/**
 * The runner (scripts/host/runner/server.mjs), started here as a plain
 * process: what it answers to what the app sends. That a container shuts its
 * programs in is checked with a real Docker (scripts/host/test/runner-container.sh).
 */

const TOKEN = "runner-test-token";
let server: ChildProcess;
let url = "";
let work = "";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

before(async () => {
  work = mkdtempSync(join(tmpdir(), "runner-test-"));
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [join(process.cwd(), "scripts/host/runner/server.mjs")], {
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      HOST: "127.0.0.1",
      RUNNER_TOKEN: TOKEN,
      WORK_BASE: work,
      RUNNER_MAX_SECONDS: "10",
      RUNNER_QUEUE_SECONDS: "2",
      RUNNER_OUTPUT_CHARS: "2000",
      RUNNER_MAX_WORK_MB: "16",
      A_SECRET_OF_THE_SERVER: "must-not-reach-a-program",
      JAVA_HOME: "/a/jdk",
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/health`)).ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error("the runner did not start");
});

after(() => {
  server?.kill("SIGKILL");
  if (work) rmSync(work, { recursive: true, force: true });
});

interface Answer {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  kept: { path: string; base64: string }[];
  notKept: { path: string; reason: string }[];
  error?: string;
}

async function run(body: Record<string, unknown>, token: string | null = TOKEN): Promise<{ status: number; text: string; json: Answer }> {
  const res = await fetch(`${url}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text.trim()) as Answer };
}

const js = (path: string, content: string) => ({ path, content });

test("it says what it can do, and runs nothing without its token", async () => {
  const health = (await (await fetch(`${url}/health`)).json()) as Record<string, unknown>;
  assert.deepEqual(
    { ok: health.ok, protocol: health.protocol, keeps: health.keeps, stream: health.stream, maxSeconds: health.maxSeconds, slots: health.slots },
    { ok: true, protocol: 2, keeps: true, stream: true, maxSeconds: 10, slots: 1 },
  );
  assert.equal((await run({ files: [], command: "node -v" }, null)).status, 401);
  assert.equal((await run({ files: [], command: "node -v" }, "another-token")).status, 401);
  assert.equal((await fetch(`${url}/nothing`)).status, 404);
});

test("a program runs on the files it is given, in a folder and a home of its own, without the server's secrets", async () => {
  const { status, json } = await run({
    files: [
      js("src/data.txt", "from a file"),
      js(
        "main.js",
        'const fs = require("fs"); console.log(JSON.stringify({ data: fs.readFileSync("src/data.txt", "utf8"), cwd: process.cwd().endsWith("/src"), home: process.env.HOME.endsWith("/home"), ' +
          'gradle: process.env.GRADLE_USER_HOME.endsWith("/home/.gradle"), tmp: fs.existsSync(process.env.TMPDIR), ci: process.env.CI, java: process.env.JAVA_HOME, ' +
          "token: process.env.RUNNER_TOKEN ?? null, secret: process.env.A_SECRET_OF_THE_SERVER ?? null })); console.error(\"to stderr\"); process.exit(3);",
      ),
    ],
    command: "node main.js",
    timeoutMs: 8000,
  });
  assert.equal(status, 200);
  assert.equal(json.exitCode, 3);
  assert.equal(json.timedOut, false);
  assert.deepEqual(JSON.parse(json.stdout), { data: "from a file", cwd: true, home: true, gradle: true, tmp: true, ci: "1", java: "/a/jdk", token: null, secret: null });
  assert.equal(json.stderr.trim(), "to stderr");
  assert.deepEqual(json.kept, []);
  // The folder of the run is gone.
  assert.deepEqual(readdirSync(work), []);
});

test("what is asked for and cannot be done is refused before anything runs", async () => {
  for (const command of ["node -e 1; ls", "node $(id)", "node a.js | cat", "node > out", "node `id`", "", "/bin/sh -c id", "./gradlew build", "-rf"]) {
    const answer = await run({ files: [], command });
    assert.equal(answer.status, 400, command);
    assert.match(answer.json.error ?? "", /invalid command/, command);
  }
  for (const path of ["../up.txt", "/etc/x", "a/../../b", "a\\b", "a//b", "./a", ""]) {
    const answer = await run({ files: [js(path, "x")], command: "node -v" });
    assert.equal(answer.status, 400, path);
    assert.match(answer.json.error ?? "", /invalid file path/, path);
  }
  assert.equal((await run({ files: "none", command: "node -v" })).status, 200);
  const notJson = await fetch(`${url}/run`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "{not json" });
  assert.equal(notJson.status, 400);
  // A program that is not there: an answer, not an error of the runner.
  const missing = await run({ files: [], command: "no-such-program-here --version" });
  assert.equal(missing.status, 200);
  assert.equal(missing.json.exitCode, null);
  assert.match(missing.json.stderr, /no-such-program-here: there is no such program here/);
});

test("the packages a program leaves behind come back; what was not asked for, a link, and a folder do not", async () => {
  const make =
    'const fs = require("fs"); fs.mkdirSync("build/libs", { recursive: true }); fs.mkdirSync("plugin/build/libs", { recursive: true }); fs.mkdirSync("node_modules/x/build/libs", { recursive: true });' +
    'fs.writeFileSync("build/libs/shop-1.0.jar", Buffer.from([0x50, 0x4b, 3, 4, 0, 255, 254]));' +
    'fs.writeFileSync("build/libs/shop-1.0-sources.jar", "sources");' +
    'fs.writeFileSync("plugin/build/libs/inner.jar", "inner");' +
    'fs.writeFileSync("node_modules/x/build/libs/dep.jar", "a dependency");' +
    'fs.writeFileSync("build/notes.txt", "not asked for");' +
    'fs.symlinkSync("/etc/hostname", "build/libs/link.jar");' +
    'fs.mkdirSync("build/libs/folder.jar");' +
    'fs.writeFileSync("pack.mcaddon", "addon");';
  const keep = keepPatterns();
  const { json } = await run({ files: [js("make.js", make)], command: "node make.js", keep, stream: true });
  assert.equal(json.exitCode, 0);
  assert.deepEqual(
    json.kept.map((k) => k.path),
    ["build/libs/shop-1.0-sources.jar", "build/libs/shop-1.0.jar", "pack.mcaddon", "plugin/build/libs/inner.jar"],
  );
  assert.deepEqual([...Buffer.from(json.kept[1]!.base64, "base64")], [0x50, 0x4b, 3, 4, 0, 255, 254]);
  // The app reads what came back with the same rules, and leaves out what a build makes besides the package.
  assert.deepEqual(
    readKept(json.kept, keep).kept.map((k) => k.path),
    ["build/libs/shop-1.0.jar", "pack.mcaddon", "plugin/build/libs/inner.jar"],
  );
  // Without patterns nothing comes back, and a failed program hands nothing back either way.
  assert.deepEqual((await run({ files: [js("make.js", make)], command: "node make.js" })).json.kept, []);
  // The limits a request names hold.
  const limited = await run({ files: [js("make.js", make)], command: "node make.js", keep, keepMaxFiles: 1 });
  assert.equal(limited.json.kept.length, 1);
  assert.equal(limited.json.notKept.length, 3);
  assert.match(limited.json.notKept[0]!.reason, /more than 1 files/);
  const small = await run({ files: [js("make.js", make)], command: "node make.js", keep: ["build/libs/*.jar"], keepMaxFileBytes: 6 });
  assert.deepEqual(small.json.kept, []);
  assert.deepEqual(small.json.notKept.map((n) => n.path), ["build/libs/shop-1.0-sources.jar", "build/libs/shop-1.0.jar"]);
});

test("the patterns mean here what they mean in the app", async () => {
  // Every pattern the app always asks for, tried on paths that fit and paths that do not, on both sides.
  const paths = ["build/libs/a.jar", "x/build/libs/a.jar", "x/y/build/libs/a.jar", "target/a.jar", "m/target/a.jar", "build/distributions/a.zip", "dist/a.zip", "dist/a.tgz", "dist/a.jar", "a.mcaddon", "a.mcpack", "a.mcworld", "deep/a.mcpack", "build/libs/a.txt"];
  const make = `const fs = require("fs"); const path = require("path"); for (const p of ${JSON.stringify(paths)}) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, "x"); }`;
  const { json } = await run({ files: [js("make.js", make)], command: "node make.js", keep: [...KEEP_DEFAULT], keepMaxFiles: 50 });
  const here = paths.filter((p) => KEEP_DEFAULT.some((pattern) => matchesPattern(pattern, p))).sort();
  assert.deepEqual(json.kept.map((k) => k.path).sort(), here);
  assert.ok(here.includes("x/build/libs/a.jar") && !here.includes("x/y/build/libs/a.jar") && !here.includes("deep/a.mcpack"));
});

test("a program whose time is up is stopped, and says so", async () => {
  const started = Date.now();
  const { json } = await run({ files: [js("wait.js", 'console.log("started"); setInterval(() => {}, 1000);')], command: "node wait.js", timeoutMs: 1200, keep: ["*.jar"] });
  assert.ok(Date.now() - started < 8000);
  assert.equal(json.exitCode, null);
  assert.equal(json.timedOut, true);
  assert.equal(json.stdout.trim(), "started");
  assert.match(json.stderr, /The program was stopped: its time was up/);
  // No longer than the runner's own limit, whatever is asked for.
  const long = await run({ files: [js("wait.js", "setInterval(() => {}, 1000);")], command: "node wait.js", timeoutMs: 3_600_000 });
  assert.equal(long.json.timedOut, true);
  assert.ok(long.json.durationMs >= 9000 && long.json.durationMs < 15_000, String(long.json.durationMs));
});

test("with stream, the answer starts at once and the result follows spaces", async () => {
  const res = await fetch(`${url}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ files: [js("slow.js", 'setTimeout(() => console.log("done"), 700);')], command: "node slow.js", stream: true }),
  });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const first = await reader.read();
  // The first bytes are there before the program has ended.
  assert.equal(Buffer.from(first.value!).toString(), " ");
  let rest = "";
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    rest += Buffer.from(part.value).toString();
  }
  assert.equal((JSON.parse(rest.trim()) as Answer).stdout.trim(), "done");
  // What is wrong with a request is still said with its status: nothing was started.
  assert.equal((await run({ files: [], command: "node -e 1; ls", stream: true })).status, 400);
});

test("one program at a time: the next one waits its turn, and gives up when the wait is over", async () => {
  const slow = run({ files: [js("slow.js", 'setTimeout(() => console.log("first"), 1200);')], command: "node slow.js" });
  await new Promise((done) => setTimeout(done, 200));
  const second = await run({ files: [js("two.js", "console.log(2)")], command: "node two.js" });
  assert.equal(second.json.stdout.trim(), "2");
  assert.equal((await slow).json.stdout.trim(), "first");
  // A wait that is longer than the runner allows: said as an error, with and without stream.
  const long = run({ files: [js("wait.js", "setInterval(() => {}, 1000);")], command: "node wait.js", timeoutMs: 5000 });
  await new Promise((done) => setTimeout(done, 200));
  const refused = await run({ files: [], command: "node -v" });
  assert.equal(refused.status, 503);
  assert.match(refused.json.error ?? "", /busy with other programs/);
  const streamed = await run({ files: [], command: "node -v", stream: true });
  assert.equal(streamed.status, 200);
  assert.match(streamed.json.error ?? "", /busy with other programs/);
  assert.equal(streamed.json.exitCode, undefined);
  await long;
});

test("a long output is kept to its start and its end", async () => {
  const { json } = await run({
    files: [js("loud.js", 'console.log("THE START"); for (let i = 0; i < 400; i++) console.log("line " + i + " " + "x".repeat(40)); console.log("THE END");')],
    command: "node loud.js",
  });
  assert.equal(json.exitCode, 0);
  assert.ok(json.stdout.startsWith("THE START"));
  assert.ok(json.stdout.trimEnd().endsWith("THE END"));
  assert.match(json.stdout, /\[… \d+ characters are left out here …\]/);
  assert.ok(json.stdout.length < 2200, String(json.stdout.length));
});

test("a program that fills its folder is stopped", async () => {
  const { json } = await run({
    files: [js("fill.js", 'const fs = require("fs"); const block = Buffer.alloc(4 * 1024 * 1024, 1); for (let i = 0; i < 8; i++) fs.writeFileSync("big" + i + ".bin", block); setInterval(() => {}, 1000);')],
    command: "node fill.js",
    timeoutMs: 9000,
  });
  assert.equal(json.exitCode, null);
  assert.equal(json.timedOut, false);
  assert.match(json.stderr, /it filled its folder: more than 16 MB/);
  assert.ok(!existsSync(join(work, "run-")));
  assert.deepEqual(readdirSync(work), []);
});
