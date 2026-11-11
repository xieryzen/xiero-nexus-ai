#!/usr/bin/env node
// Release metadata for scripts and CI, read from package.json. No dependencies.
//
//   node scripts/release-info.mjs              → prints key=value lines
//   node scripts/release-info.mjs --get tag    → prints one value
//   node scripts/release-info.mjs --notes      → prints the CHANGELOG section for this version

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");

/** Versions the release tooling accepts: semver with an optional pre-release, no build metadata. */
export function isValidVersion(version) {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/.test(version);
}

/** Channel implied by a semver string (keep in sync with src/lib/version.ts). */
export function channelOf(version) {
  const dash = version.indexOf("-");
  if (dash === -1) return "stable";
  const pre = version.slice(dash + 1).toLowerCase();
  if (pre.startsWith("rc")) return "rc";
  if (pre.startsWith("beta")) return "beta";
  if (pre.startsWith("alpha")) return "alpha";
  return "prerelease";
}

/** The "## [x.y.z]" section of a Keep-a-Changelog file, without its heading. */
export function changelogSection(markdown, version) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## [")) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

/**
 * Join hard-wrapped lines into one line per paragraph or list item. GitHub
 * renders every newline in release notes as a line break, so text wrapped for
 * a file would otherwise break mid-sentence. Code blocks are left alone.
 */
export function unwrap(markdown) {
  const startsBlock = (l) => /^\s*([-*+]\s|\d+\.\s|#{1,6}\s|>|\||```|~~~)/.test(l);
  const out = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    const prev = out[out.length - 1];
    const continues =
      !inFence &&
      line.trim() !== "" &&
      prev !== undefined &&
      prev.trim() !== "" &&
      !startsBlock(line) &&
      !/^\s*(#{1,6}\s|\||```|~~~)/.test(prev);
    if (continues) out[out.length - 1] = `${prev} ${line.trim()}`;
    else out.push(line);
  }
  return out.join("\n");
}

export function releaseInfo() {
  const version = JSON.parse(read("package.json")).version;
  if (!isValidVersion(version)) {
    throw new Error(`package.json version "${version}" is not a valid release version (expected e.g. 1.4.0 or 1.4.0-beta.1)`);
  }
  const channel = channelOf(version);
  return {
    version,
    tag: `v${version}`,
    channel,
    prerelease: channel === "stable" ? "false" : "true",
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [flag, key] = process.argv.slice(2);
  let info;
  try {
    info = releaseInfo();
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
  if (flag === "--notes") {
    const notes = existsSync(new URL("CHANGELOG.md", root))
      ? changelogSection(read("CHANGELOG.md"), info.version)
      : "";
    process.stdout.write(`${unwrap(notes) || `Release ${info.tag}. See CHANGELOG.md for details.`}\n`);
  } else if (flag === "--get") {
    if (!Object.hasOwn(info, key ?? "")) {
      console.error(`error: unknown key "${key ?? ""}". Known keys: ${Object.keys(info).join(", ")}`);
      process.exit(2);
    }
    process.stdout.write(`${info[key]}\n`);
  } else {
    process.stdout.write(
      `${Object.entries(info)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n")}\n`,
    );
  }
}
