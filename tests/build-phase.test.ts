import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUILD_FIX_ROUNDS,
  FIX_ACCEPTANCE,
  buildNote,
  fixObjective,
  fixTitle,
  grantedTools,
  isFixTask,
  pickFixer,
  type BuildReport,
} from "../src/lib/orchestrator/build-phase";
import { buildOf } from "../src/lib/result/kinds";
import { KEEP_MAX_FILES, maxTimeoutMs, readKept, readNotKept } from "../src/lib/workspace/kept";
import { autoMedia } from "../src/lib/model-choice-rules";

const gradle = buildOf(["build.gradle.kts", "settings.gradle.kts", "src/main/java/a/A.java"])!;
const maven = buildOf(["plugin/pom.xml", "plugin/src/main/java/a/A.java"])!;

test("the task that makes a build work is known by its title", () => {
  assert.equal(fixTitle(1), "Make the project build");
  assert.equal(fixTitle(2), "Make the project build (attempt 2)");
  assert.ok(isFixTask(fixTitle(1)));
  assert.ok(isFixTask(fixTitle(3)));
  assert.ok(!isFixTask("Make the project build faster"));
  assert.ok(!isFixTask("Write the plugin"));
  assert.ok(BUILD_FIX_ROUNDS >= 1);
});

test("what the agent is asked: the command, the end of what the build said, and not to take features out", () => {
  const log = `${"x".repeat(9000)}\nsrc/main/java/a/A.java:12: error: ';' expected`;
  const asked = fixObjective(gradle, log, true);
  assert.match(asked, /built into a package with Gradle \(build\.gradle\.kts\), and the build fails/);
  assert.ok(asked.includes(gradle.command));
  assert.ok(asked.includes("A.java:12: error: ';' expected"));
  // The start of a long log is left out, and that is said.
  assert.ok(asked.includes("(the start is left out)"));
  assert.ok(asked.length < 8000);
  assert.match(asked, /run the build command with run_command/);
  assert.match(asked, /gradle --version/);
  assert.match(asked, /do not take a feature out to make an error go away/);
  // An agent that cannot run it is told so, and not to use a tool it does not have.
  const blind = fixObjective(maven, "", false);
  assert.match(blind, /You cannot run the build yourself/);
  assert.ok(!blind.includes("with run_command"));
  assert.ok(blind.includes("(it printed nothing)"));
  assert.ok(blind.includes("mvn -B -ntp -q -DskipTests -f plugin/pom.xml package"));
  assert.match(FIX_ACCEPTANCE, /exits with code 0/);
});

test("the tools a task is handed are read from its row, and from nothing else", () => {
  assert.deepEqual(grantedTools('{"tools":["run_command"]}'), ["run_command"]);
  assert.deepEqual(grantedTools('{"tools":["run_command",5,null,"write_file"]}'), ["run_command", "write_file"]);
  assert.deepEqual(grantedTools('{"aspectRatio":"9:16"}'), []);
  assert.deepEqual(grantedTools('{"tools":"run_command"}'), []);
  assert.deepEqual(grantedTools("not json"), []);
  assert.deepEqual(grantedTools(null), []);
  assert.deepEqual(grantedTools(""), []);
});

test("who makes the build work: the one that wrote the build file, else the one that wrote the most", () => {
  const file = "build.gradle.kts";
  // The agent whose task wrote the build file.
  assert.equal(
    pickFixer(
      [
        { agentId: "writer", seq: 1, wrote: ["README.md", "docs/a.md", "docs/b.md"], canWrite: true },
        { agentId: "dev", seq: 2, wrote: [file, "src/A.java"], canWrite: true },
      ],
      file,
    ),
    "dev",
  );
  // Of two that wrote it, the later one.
  assert.equal(
    pickFixer(
      [
        { agentId: "first", seq: 1, wrote: [file], canWrite: true },
        { agentId: "second", seq: 3, wrote: [file], canWrite: true },
      ],
      file,
    ),
    "second",
  );
  // Nobody wrote it with a tool (it came from a task's output): the one that wrote the most files.
  assert.equal(
    pickFixer(
      [
        { agentId: "a", seq: 1, wrote: ["x"], canWrite: true },
        { agentId: "b", seq: 2, wrote: ["y", "z"], canWrite: true },
        { agentId: "a", seq: 3, wrote: ["w", "v"], canWrite: true },
      ],
      file,
    ),
    "a",
  );
  // An agent that cannot write a file cannot correct one.
  assert.equal(
    pickFixer(
      [
        { agentId: "reader", seq: 1, wrote: [file], canWrite: false },
        { agentId: "dev", seq: 2, wrote: [], canWrite: true },
      ],
      file,
    ),
    "dev",
  );
  assert.equal(pickFixer([{ agentId: "reader", seq: 1, wrote: [file], canWrite: false }], file), null);
  assert.equal(pickFixer([{ agentId: null, seq: 1, wrote: [file], canWrite: true }], file), null);
  assert.equal(pickFixer([], file), null);
});

test("what the manager and the reviewer are told about the build", () => {
  const base: BuildReport = { plan: gradle, ok: true, exitCode: 0, timedOut: false, log: "", kept: [{ path: "build/libs/shop-1.0.0.jar", sizeBytes: 41_234 }], fixRounds: 0 };
  const good = buildNote(base);
  assert.match(good, /the build succeeded\./);
  assert.ok(good.includes("build/libs/shop-1.0.0.jar (40 KB)"));
  assert.match(good, /downloads from the project page/);
  // It was compiled, not run: nobody is to read more into it.
  assert.match(good, /was not tried: it was compiled and packed, not run/);
  assert.match(buildNote({ ...base, fixRounds: 1 }), /succeeded after one task that corrected what stopped it/);
  assert.match(buildNote({ ...base, fixRounds: 2 }), /after 2 tasks that corrected/);
  assert.match(buildNote({ ...base, kept: [] }), /It left no package behind\./);

  const failed = buildNote({ ...base, ok: false, exitCode: 1, kept: [], fixRounds: 2, log: `${"y".repeat(4000)}\nerror: cannot find symbol` });
  assert.match(failed, /the build FAILED \(exit code 1\), also after 2 tasks that tried to correct it/);
  assert.match(failed, /There is no package/);
  assert.ok(failed.includes("error: cannot find symbol"));
  assert.ok(failed.length < 2600);
  assert.match(buildNote({ ...base, ok: false, exitCode: null, timedOut: true, kept: [] }), /FAILED \(its time was up\)/);
  assert.match(buildNote({ ...base, ok: false, exitCode: null, kept: [], notBuilt: "the runner did not answer" }), /was not built with Gradle .*: the runner did not answer/);
});

test("what a runner hands back is held to what was asked for", () => {
  const b64 = (text: string) => Buffer.from(text).toString("base64");
  const patterns = ["build/libs/*.jar", "dist/*.zip"];
  const read = readKept(
    [
      { path: "build/libs/shop-1.0.jar", base64: b64("PK-jar") },
      // Not asked for.
      { path: "secrets.txt", base64: b64("no") },
      { path: "build/libs/deep/x.jar", base64: b64("no") },
      // Outside the folder, by any spelling.
      { path: "../build/libs/up.jar", base64: b64("no") },
      { path: "/build/libs/abs.jar", base64: b64("no") },
      { path: "build/libs/../../etc/x.jar", base64: b64("no") },
      // What a build makes besides the package.
      { path: "build/libs/shop-1.0-sources.jar", base64: b64("no") },
      { path: "build/libs/original-shop-1.0.jar", base64: b64("no") },
      // The same file twice.
      { path: "build/libs/shop-1.0.jar", base64: b64("again") },
      { path: "dist/site.zip", base64: b64("PK-zip") },
      // Not a file as a runner hands one back.
      { path: "dist/x.zip" },
      { base64: b64("no") },
      null,
      "dist/y.zip",
    ],
    patterns,
  );
  assert.deepEqual(
    read.kept.map((k) => [k.path, k.data.toString()]),
    [
      ["build/libs/shop-1.0.jar", "PK-jar"],
      ["dist/site.zip", "PK-zip"],
    ],
  );
  assert.deepEqual(read.notKept, []);
  assert.deepEqual(readKept("not a list", patterns), { kept: [], notKept: [] });
  assert.deepEqual(readKept([{ path: "build/libs/a.jar", base64: b64("x") }], []), { kept: [], notKept: [] });

  // More files than are kept: the rest is named, with the reason.
  const many = Array.from({ length: KEEP_MAX_FILES + 2 }, (_, i) => ({ path: `dist/p${i}.zip`, base64: b64("x") }));
  const capped = readKept(many, patterns);
  assert.equal(capped.kept.length, KEEP_MAX_FILES);
  assert.equal(capped.notKept.length, 2);
  assert.match(capped.notKept[0]!.reason, /more than \d+ files/);

  assert.deepEqual(readNotKept([{ path: "a.jar", reason: "larger than 48 MB" }, { path: 1, reason: "x" }, "no"]), [{ path: "a.jar", reason: "larger than 48 MB" }]);
  assert.deepEqual(readNotKept(undefined), []);
});

test("the longest a program may run: two minutes, or what SANDBOX_MAX_SECONDS says, within reason", () => {
  assert.equal(maxTimeoutMs(undefined), 120_000);
  assert.equal(maxTimeoutMs(""), 120_000);
  assert.equal(maxTimeoutMs("soon"), 120_000);
  assert.equal(maxTimeoutMs("900"), 900_000);
  assert.equal(maxTimeoutMs("1"), 10_000);
  assert.equal(maxTimeoutMs("999999"), 3_600_000);
});

test("media without a model named: on unless it is switched off", () => {
  assert.equal(autoMedia(undefined), true);
  assert.equal(autoMedia(""), true);
  assert.equal(autoMedia("1"), true);
  assert.equal(autoMedia("yes"), true);
  for (const off of ["0", "false", "off", "no", " OFF ", "False"]) assert.equal(autoMedia(off), false, off);
});
