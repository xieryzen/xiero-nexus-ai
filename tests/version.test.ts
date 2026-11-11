import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseChannel } from "../src/lib/version";
import { changelogSection, channelOf } from "../scripts/release-info.mjs";

const cases: [string, string][] = [
  ["1.4.0", "stable"],
  ["2.0.0", "stable"],
  ["1.4.0-rc.1", "rc"],
  ["1.4.0-beta.2", "beta"],
  ["1.4.0-alpha.0", "alpha"],
  ["1.0.0-premium", "prerelease"],
];

test("releaseChannel maps semver suffixes to channels", () => {
  for (const [version, channel] of cases) {
    assert.equal(releaseChannel(version), channel, version);
  }
});

test("CI script and app agree on the channel for every version", () => {
  for (const [version] of cases) {
    assert.equal(channelOf(version), releaseChannel(version), version);
  }
});

test("changelogSection extracts exactly one version's notes", () => {
  const md = [
    "# Changelog",
    "",
    "## [1.4.0-beta.1] - 2026-12-01",
    "### Added",
    "- New thing",
    "",
    "## [1.3.0] - 2026-11-11",
    "### Added",
    "- Older thing",
  ].join("\n");
  assert.equal(changelogSection(md, "1.4.0-beta.1"), "### Added\n- New thing");
  assert.equal(changelogSection(md, "1.3.0"), "### Added\n- Older thing");
  assert.equal(changelogSection(md, "9.9.9"), "");
});
