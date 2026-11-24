// Asks the runner in this container to do something, the way the app asks,
// and says in one line how it went: "ok ..." or "no ...". For the script
// that sets the runner up (scripts/host/runner-service.sh), and for a person
// who wants to know whether a build works here:
//
//   docker exec xiero-runner node /srv/selftest.mjs            who a program runs as
//   docker exec xiero-runner node /srv/selftest.mjs gradle     a Paper plugin, built with Gradle
//   docker exec xiero-runner node /srv/selftest.mjs maven      a small jar, built with Maven
//
//   SELFTEST_PAPER, SELFTEST_JAVA   the Paper API and the Java the plugin is built for (1.21.4, 21)
//   SELFTEST_GRADLE                 8 or 9: the Gradle it is built with (8)
//   SELFTEST_SECONDS                the longest the build may take (the runner's limit)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const what = process.argv[2] || "whoami";
const port = process.env.PORT || "8080";
const token = process.env.RUNNER_TOKEN || "";
const WARM = "/opt/runner/warm";

function filesOf(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...filesOf(join(dir, entry.name), path));
    else if (entry.isFile()) out.push({ path, content: readFileSync(join(dir, entry.name), "utf8") });
  }
  return out;
}

async function run(body) {
  const res = await fetch(`http://127.0.0.1:${port}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ stream: true, ...body }),
  });
  const text = (await res.text()).trim();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`the runner answered ${res.status} with something that is not a result`);
  }
  if (typeof json.error === "string" && typeof json.exitCode !== "number") throw new Error(json.error);
  return json;
}

const lastLines = (result) =>
  [result.stdout, result.stderr]
    .join("\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-6)
    .join(" | ")
    .slice(0, 900);

try {
  if (what === "whoami") {
    const result = await run({
      files: [
        {
          path: "who.js",
          content:
            'const fs = require("fs");' +
            'let server = "no"; try { fs.readFileSync("/proc/1/environ"); server = "yes"; } catch {}' +
            'let outside = "no"; try { fs.writeFileSync("/srv/x", "x"); outside = "yes"; } catch {}' +
            'console.log(JSON.stringify({ uid: process.getuid(), gid: process.getgid(), server, outside, token: process.env.RUNNER_TOKEN ? "yes" : "no" }));',
        },
      ],
      command: "node who.js",
      timeoutMs: 20_000,
    });
    if (result.exitCode !== 0) throw new Error(`a program could not be run (${lastLines(result) || `exit code ${result.exitCode}`})`);
    const who = JSON.parse(result.stdout.trim().split("\n").pop());
    console.log(`ok uid=${who.uid} gid=${who.gid} reads-server=${who.server} writes-outside=${who.outside} has-token=${who.token}`);
  } else if (what === "gradle" || what === "maven") {
    const paper = process.env.SELFTEST_PAPER || "1.21.4";
    const java = process.env.SELFTEST_JAVA || "21";
    const gradle = process.env.SELFTEST_GRADLE === "9" ? "9" : "8";
    const files =
      what === "gradle"
        ? [
            ...filesOf(join(WARM, "paper")).map((file) => ({
              path: file.path,
              content: file.content.replaceAll("@PAPER@", paper).replaceAll("@JAVA@", java),
            })),
            // The file that says which Gradle the project was written for.
            {
              path: "gradle/wrapper/gradle-wrapper.properties",
              content: `distributionUrl=https\\://services.gradle.org/distributions/gradle-${gradle === "9" ? "9.0.0" : "8.14"}-bin.zip\n`,
            },
          ]
        : filesOf(join(WARM, "maven"));
    const seconds = Number(process.env.SELFTEST_SECONDS) > 0 ? Number(process.env.SELFTEST_SECONDS) : 3600;
    const result = await run({
      files,
      command: what === "gradle" ? "gradle build -x test --console=plain -q" : "mvn -B -ntp -q -DskipTests package",
      keep: what === "gradle" ? ["build/libs/*.jar"] : ["target/*.jar"],
      timeoutMs: seconds * 1000,
    });
    const took = `${(result.durationMs / 1000).toFixed(1)} s`;
    if (result.exitCode !== 0) throw new Error(`the build ${result.timedOut ? "ran out of time" : `ended with code ${result.exitCode}`} after ${took}: ${lastLines(result) || "it said nothing"}`);
    const jar = (result.kept || [])[0];
    if (!jar) throw new Error(`the build succeeded in ${took}, but no package came back`);
    const bytes = Buffer.from(jar.base64, "base64");
    // A jar is a ZIP: it starts with "PK".
    if (bytes.length < 200 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error(`what came back as ${jar.path} is not a jar`);
    console.log(`ok ${took} ${jar.path} ${bytes.length} bytes${what === "gradle" ? ` (Paper ${paper}, Java ${java}, Gradle ${gradle})` : ""}`);
  } else {
    console.log(`no "${what}" is not something this asks: whoami, gradle, maven`);
  }
} catch (err) {
  console.log(`no ${String(err?.message || err).replace(/\s+/g, " ").slice(0, 1200)}`);
}
