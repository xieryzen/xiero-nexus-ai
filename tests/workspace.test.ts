import assert from "node:assert/strict";
import { test } from "node:test";
import { validateWorkspacePath } from "../src/lib/workspace/paths";
import { DEFAULT_ALLOWED_COMMANDS, parseCommand } from "../src/lib/workspace/command";

test("valid relative paths pass", () => {
  assert.equal(validateWorkspacePath("src/index.ts"), "src/index.ts");
  assert.equal(validateWorkspacePath("README.md"), "README.md");
  assert.equal(validateWorkspacePath("a/b/c/d.txt"), "a/b/c/d.txt");
});

test("traversal and absolute paths are rejected", () => {
  for (const p of ["../etc/passwd", "a/../../b", "/etc/passwd", "a/./b", "..", "a\\b", "a/\u0000b"]) {
    assert.throws(() => validateWorkspacePath(p), new RegExp(""), `${p} should be rejected`);
  }
});

test("command allowlist accepts known binaries", () => {
  assert.deepEqual(parseCommand("npm test", DEFAULT_ALLOWED_COMMANDS).argv, ["npm", "test"]);
  assert.deepEqual(parseCommand("node build.js", DEFAULT_ALLOWED_COMMANDS).argv, ["node", "build.js"]);
});

test("command allowlist rejects unknown binaries", () => {
  assert.throws(() => parseCommand("rm -rf /", DEFAULT_ALLOWED_COMMANDS));
  assert.throws(() => parseCommand("curl http://x", DEFAULT_ALLOWED_COMMANDS));
});

test("shell metacharacters are rejected", () => {
  for (const c of ["npm test; rm -rf /", "node x.js && curl evil", "cat f | sh", "echo $(whoami)", "node `id`"]) {
    assert.throws(() => parseCommand(c, DEFAULT_ALLOWED_COMMANDS), new RegExp(""), `${c} should be rejected`);
  }
});
