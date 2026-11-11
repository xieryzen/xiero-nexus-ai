import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { channelOf, isValidVersion, unwrap } from "../scripts/release-info.mjs";
import {
  DEV_TAG,
  assetName,
  channelOf as helperChannelOf,
  compareVersions,
  parseChecksums,
  pickRelease,
  versionOfTag,
} from "../scripts/get-release.mjs";

const release = (tag_name: string, extra: Record<string, unknown> = {}) => ({
  tag_name,
  draft: false,
  assets: [],
  ...extra,
});

test("package.json carries a version the release tooling accepts", () => {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(isValidVersion(version), true, version);
});

test("isValidVersion accepts semver with an optional pre-release and nothing else", () => {
  for (const ok of ["1.3.0", "0.0.1", "10.20.30", "1.4.0-beta.1", "1.4.0-rc.0", "2.0.0-alpha", "1.0.0-x-y.z"]) {
    assert.equal(isValidVersion(ok), true, ok);
  }
  for (const bad of ["1.3", "v1.3.0", "1.3.0.1", "01.3.0", "1.3.0-", "1.3.0+build.5", "1.3.0 ", "latest", ""]) {
    assert.equal(isValidVersion(bad), false, bad);
  }
});

test("the download helper derives channels exactly like the release script", () => {
  for (const v of ["1.4.0", "1.4.0-rc.1", "1.4.0-beta.2", "1.4.0-alpha.0", "1.0.0-premium"]) {
    assert.equal(helperChannelOf(v), channelOf(v), v);
  }
});

test("compareVersions follows semver precedence", () => {
  const ascending = [
    "1.3.0",
    "1.4.0-alpha.0",
    "1.4.0-alpha.1",
    "1.4.0-alpha.beta",
    "1.4.0-beta.2",
    "1.4.0-beta.10",
    "1.4.0-rc.0",
    "1.4.0",
    "1.4.1",
    "1.10.0",
    "2.0.0",
  ];
  for (let i = 0; i < ascending.length; i++) {
    for (let j = 0; j < ascending.length; j++) {
      const got = Math.sign(compareVersions(ascending[i]!, ascending[j]!));
      assert.equal(got, Math.sign(i - j), `${ascending[i]} vs ${ascending[j]}`);
    }
  }
  assert.throws(() => compareVersions("1.4", "1.4.0"));
});

test("versionOfTag only accepts version tags", () => {
  assert.equal(versionOfTag("v1.4.0-beta.1"), "1.4.0-beta.1");
  assert.equal(versionOfTag(DEV_TAG), null);
  assert.equal(versionOfTag("1.4.0"), null);
  assert.equal(versionOfTag("vnext"), null);
});

test("pickRelease: a channel means that stability or better, newest version first", () => {
  // Deliberately out of order: selection must not depend on list order.
  const releases = [
    release("v1.3.0"),
    release(DEV_TAG),
    release("v1.4.0-alpha.3"),
    release("v1.4.0-beta.2"),
    release("v1.4.0-beta.10"),
    release("v1.4.0-rc.1"),
    release("v1.3.1"),
    release("v9.9.9", { draft: true }),
    release("v1.5.0-premium"),
  ];
  assert.equal(pickRelease(releases, "stable")?.tag_name, "v1.3.1");
  assert.equal(pickRelease(releases, "rc")?.tag_name, "v1.4.0-rc.1");
  assert.equal(pickRelease(releases, "beta")?.tag_name, "v1.4.0-rc.1");
  assert.equal(pickRelease(releases, "alpha")?.tag_name, "v1.4.0-rc.1");
  assert.equal(pickRelease(releases, "dev")?.tag_name, DEV_TAG);
  assert.equal(pickRelease(releases, "BETA")?.tag_name, "v1.4.0-rc.1");
});

test("pickRelease: a newer stable release wins on every channel", () => {
  const releases = [release("v1.4.0-beta.2"), release("v1.4.0"), release("v1.4.0-rc.1")];
  for (const channel of ["stable", "rc", "beta", "alpha"]) {
    assert.equal(pickRelease(releases, channel)?.tag_name, "v1.4.0", channel);
  }
});

test("pickRelease: beta does not fall back to something less stable", () => {
  const releases = [release("v1.4.0-alpha.1"), release(DEV_TAG)];
  assert.equal(pickRelease(releases, "beta"), null);
  assert.equal(pickRelease(releases, "stable"), null);
  assert.equal(pickRelease(releases, "alpha")?.tag_name, "v1.4.0-alpha.1");
});

test("pickRelease: an exact version matches with or without the v, never a draft", () => {
  const releases = [release("v1.4.0-beta.2"), release("v1.3.0"), release("v2.0.0", { draft: true })];
  assert.equal(pickRelease(releases, "1.4.0-beta.2")?.tag_name, "v1.4.0-beta.2");
  assert.equal(pickRelease(releases, "v1.3.0")?.tag_name, "v1.3.0");
  assert.equal(pickRelease(releases, "2.0.0"), null);
  assert.equal(pickRelease(releases, "1.4.0"), null);
  assert.equal(pickRelease([], "stable"), null);
});

test("assetName and parseChecksums match what the release pipeline produces", () => {
  assert.equal(assetName("linux-x64", "22"), "xiero-nexus-ai-linux-x64-node22.zip");
  const a = "a".repeat(64);
  const b = "B".repeat(64);
  const sums = parseChecksums(
    `${a}  xiero-nexus-ai-linux-x64-node20.zip\n${b} *xiero-nexus-ai-linux-x64-node22.zip\r\nnot a checksum line\n`,
  );
  assert.equal(sums.get("xiero-nexus-ai-linux-x64-node20.zip"), a);
  assert.equal(sums.get("xiero-nexus-ai-linux-x64-node22.zip"), b.toLowerCase());
  assert.equal(sums.size, 2);
});

test("unwrap joins wrapped paragraphs and list items but keeps structure and code", () => {
  const wrapped = [
    "First paragraph that was",
    "wrapped for the file.",
    "",
    "### Added",
    "",
    "- An item that runs over",
    "  two lines.",
    "- A second item.",
    "",
    "```bash",
    "npm run build",
    "npm run package",
    "```",
    "",
    "| A | B |",
    "|---|---|",
    "| 1 | 2 |",
    "Trailing text",
    "continues here.",
  ].join("\n");
  assert.equal(
    unwrap(wrapped),
    [
      "First paragraph that was wrapped for the file.",
      "",
      "### Added",
      "",
      "- An item that runs over two lines.",
      "- A second item.",
      "",
      "```bash",
      "npm run build",
      "npm run package",
      "```",
      "",
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "Trailing text continues here.",
    ].join("\n"),
  );
  assert.equal(unwrap(""), "");
});
