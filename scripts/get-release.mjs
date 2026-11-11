#!/usr/bin/env node
// Download a Xiero Nexus AI release bundle that fits this machine.
// One file, no dependencies. Needs Node.js 20 or newer.
//
//   node get-release.mjs                 newest stable release
//   node get-release.mjs beta            newest release that is beta or more stable
//   node get-release.mjs 1.4.0-beta.1    exactly that version
//   node get-release.mjs dev             build of the newest commit (not a tested release)
//   node get-release.mjs --list          show what can be downloaded
//
// Options:
//   --node <major>       bundle for another Node.js major version (default: this one)
//   --out <folder>       where to save the zip (default: the current folder)
//   --repo <owner/name>  another repository (default: xieryzen/xiero-nexus-ai)
//
// A private repository needs a token that can read it, in GH_TOKEN.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_REPO = "xieryzen/xiero-nexus-ai";
/** Tag of the rolling build of the newest commit on main. */
export const DEV_TAG = "dev-build";

/** Lower is more stable. Asking for a channel accepts everything at least as stable. */
const STABILITY = { stable: 0, rc: 1, beta: 2, alpha: 3 };

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** Channel implied by a semver string (same rule as scripts/release-info.mjs). */
export function channelOf(version) {
  const dash = version.indexOf("-");
  if (dash === -1) return "stable";
  const pre = version.slice(dash + 1).toLowerCase();
  if (pre.startsWith("rc")) return "rc";
  if (pre.startsWith("beta")) return "beta";
  if (pre.startsWith("alpha")) return "alpha";
  return "prerelease";
}

/** Semver precedence: negative when a is older than b, positive when newer. */
export function compareVersions(a, b) {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) throw new Error(`not a version: ${pa ? b : a}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  const ia = pa[4] ? pa[4].split(".") : [];
  const ib = pb[4] ? pb[4].split(".") : [];
  // A release is newer than its own pre-releases.
  if (ia.length === 0 || ib.length === 0) return ib.length - ia.length;
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const x = ia[i];
    const y = ib[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (nx !== ny) {
      return nx ? -1 : 1; // numbers sort before text
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** "v1.4.0-beta.1" → "1.4.0-beta.1"; null for tags that are not versions. */
export function versionOfTag(tag) {
  return typeof tag === "string" && tag.startsWith("v") && SEMVER.test(tag.slice(1))
    ? tag.slice(1)
    : null;
}

/**
 * Choose a release from GitHub's release list.
 * `want` is a channel (stable | rc | beta | alpha), "dev", or an exact version.
 */
export function pickRelease(releases, want) {
  const live = releases.filter((r) => !r.draft);
  const wanted = String(want).toLowerCase();
  if (wanted === "dev" || wanted === DEV_TAG) {
    return live.find((r) => r.tag_name === DEV_TAG) ?? null;
  }
  if (Object.hasOwn(STABILITY, wanted)) {
    const candidates = live
      .map((r) => ({ release: r, version: versionOfTag(r.tag_name) }))
      .filter((c) => c.version && (STABILITY[channelOf(c.version)] ?? Infinity) <= STABILITY[wanted])
      .sort((x, y) => compareVersions(y.version, x.version));
    return candidates[0]?.release ?? null;
  }
  const tag = `v${String(want).replace(/^v/i, "")}`;
  return live.find((r) => r.tag_name === tag) ?? null;
}

export function assetName(platform, nodeMajor) {
  return `xiero-nexus-ai-${platform}-node${nodeMajor}.zip`;
}

/** Parse `sha256sum` output into a Map of file name → hex digest. */
export function parseChecksums(text) {
  const sums = new Map();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (m) sums.set(m[2], m[1].toLowerCase());
  }
  return sums;
}

function labelOf(release) {
  if (release.tag_name === DEV_TAG) return "dev";
  const version = versionOfTag(release.tag_name);
  return version ? channelOf(version) : "other";
}

function usage() {
  return [
    "Usage: node get-release.mjs [stable|rc|beta|alpha|dev|<version>] [options]",
    "",
    "  (nothing)        newest stable release",
    "  beta             newest release that is beta or more stable (same idea for rc, alpha)",
    "  1.4.0-beta.1     exactly that version",
    "  dev              build of the newest commit (not a tested release)",
    "",
    "  --list               show what can be downloaded",
    "  --node <major>       bundle for another Node.js major version (default: this one)",
    "  --out <folder>       where to save the zip (default: the current folder)",
    "  --repo <owner/name>  another repository",
    "",
    "A private repository needs a token that can read it, in GH_TOKEN.",
  ].join("\n");
}

function parseArgs(argv) {
  const opts = { want: "stable", list: false, node: process.versions.node.split(".")[0], out: ".", repo: null };
  let positional = 0;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${arg} needs a value`);
      return v;
    };
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--list") opts.list = true;
    else if (arg === "--node") opts.node = value().replace(/^node/i, "");
    else if (arg === "--out") opts.out = value();
    else if (arg === "--repo") opts.repo = value();
    else if (arg.startsWith("-")) throw new UsageError(`unknown option ${arg}`);
    else if (positional++ === 0) opts.want = arg;
    else throw new UsageError(`unexpected argument ${arg}`);
  }
  if (!/^\d+$/.test(opts.node)) throw new UsageError("--node takes a major version number, for example 22");
  return opts;
}

class UsageError extends Error {}

async function request(url, headers) {
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) });
  } catch (err) {
    throw new Error(`could not reach ${new URL(url).host}: ${err.cause?.message ?? err.message}`);
  }
  if (res.ok) return res;
  let hint = "";
  if (res.status === 404) hint = " If the repository is private, set GH_TOKEN to a token that can read it.";
  else if (res.status === 401) hint = " The token in GH_TOKEN was rejected.";
  else if (res.headers.get("x-ratelimit-remaining") === "0") {
    hint = " GitHub's request limit for this address is used up; wait an hour or set GH_TOKEN.";
  }
  throw new Error(`${new URL(url).host} answered ${res.status} ${res.statusText}.${hint}`);
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(usage());
    return;
  }

  const repo = opts.repo ?? process.env.XIERO_NEXUS_REPO ?? DEFAULT_REPO;
  const api = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const headers = {
    "user-agent": "xiero-nexus-get-release",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };

  // Newest 100 releases; plenty for choosing the newest of a channel.
  const releases = await (
    await request(`${api}/repos/${repo}/releases?per_page=100`, {
      ...headers,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    })
  ).json();
  const platform = `${process.platform}-${process.arch}`;

  if (opts.list) {
    const rows = releases.filter((r) => !r.draft);
    if (rows.length === 0) {
      console.log(`${repo} has no releases yet.`);
      return;
    }
    console.log(`Releases of ${repo}, newest first (bundles for ${platform}):\n`);
    for (const r of rows) {
      const nodes = r.assets
        .map((a) => new RegExp(`^xiero-nexus-ai-${platform}-node(\\d+)\\.zip$`).exec(a.name)?.[1])
        .filter(Boolean)
        .sort((a, b) => a - b)
        .map((n) => `node${n}`);
      console.log(
        `  ${r.tag_name.padEnd(22)} ${labelOf(r).padEnd(11)} ${(r.published_at ?? "").slice(0, 10).padEnd(12)} ${nodes.join(", ") || "(no bundle for this platform)"}`,
      );
    }
    return;
  }

  const release = pickRelease(releases, opts.want);
  if (!release) {
    const tags = releases.filter((r) => !r.draft).map((r) => r.tag_name);
    throw new Error(
      `no release matches "${opts.want}" in ${repo}. ` +
        (tags.length ? `Available: ${tags.join(", ")}.` : "It has no releases yet."),
    );
  }

  const wantedAsset = assetName(platform, opts.node);
  const asset = release.assets.find((a) => a.name === wantedAsset);
  if (!asset) {
    const have = release.assets.map((a) => a.name).filter((n) => n.endsWith(".zip"));
    throw new Error(
      `${release.tag_name} has no bundle for ${platform} with Node.js ${opts.node} (${wantedAsset}).\n` +
        `  Bundles in that release: ${have.join(", ") || "none"}.\n` +
        "  Use --node <major> to pick one of those and run it with that Node.js version, or build from source (see RELEASING.md).",
    );
  }
  const sumsAsset = release.assets.find((a) => a.name === "SHA256SUMS.txt");
  if (!sumsAsset) throw new Error(`${release.tag_name} has no SHA256SUMS.txt, so the download cannot be checked.`);

  console.log(`Xiero Nexus AI ${release.tag_name} (${labelOf(release)}) for ${platform}, Node.js ${opts.node}`);
  console.log(`Downloading ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)…`);

  const binary = { ...headers, accept: "application/octet-stream" };
  const [zip, sums] = await Promise.all([
    request(asset.url, binary).then(async (r) => Buffer.from(await r.arrayBuffer())),
    request(sumsAsset.url, binary).then((r) => r.text()),
  ]);

  const expected = parseChecksums(sums).get(asset.name);
  const actual = createHash("sha256").update(zip).digest("hex");
  if (!expected) throw new Error(`SHA256SUMS.txt of ${release.tag_name} does not list ${asset.name}.`);
  if (expected !== actual) {
    throw new Error(
      `checksum mismatch for ${asset.name}: expected ${expected}, got ${actual}. Nothing was saved; try again.`,
    );
  }

  const outDir = resolve(opts.out);
  mkdirSync(outDir, { recursive: true });
  const fileName = `xiero-nexus-ai-${release.tag_name}-${platform}-node${opts.node}.zip`;
  const target = resolve(outDir, fileName);
  writeFileSync(target, zip);

  console.log(`Checksum verified (sha256 ${actual.slice(0, 12)}…)`);
  console.log(`Saved ${target}`);
  console.log(
    [
      "",
      "First install, from this folder:",
      `  unzip -q ${fileName}`,
      "  cp xiero-nexus-ai/.env.example xiero-nexus-ai/.env    # then set SECRET_ENCRYPTION_KEY in it",
      "  node xiero-nexus-ai/start.js",
      "",
      "Upgrade of an existing xiero-nexus-ai/ folder (stop the app and back up xiero-nexus-ai/data first;",
      ".env and data/ are kept):",
      "  rm -rf xiero-nexus-ai/.next xiero-nexus-ai/node_modules",
      `  unzip -oq ${fileName}`,
    ].join("\n"),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    if (err instanceof UsageError) {
      console.error(`error: ${err.message}\n\n${usage()}`);
      process.exit(2);
    }
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
}
