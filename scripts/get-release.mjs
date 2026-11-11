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
//
// Without a token, files come from GitHub's plain download links. The GitHub
// API is only asked when a pre-release channel (rc, beta, alpha) or --list has
// to be resolved, because its anonymous allowance is small and shared by
// everyone behind the same network address.

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

function labelOfTag(tag) {
  if (tag === DEV_TAG) return "dev";
  const version = versionOfTag(tag);
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

const UA = { "user-agent": "xiero-nexus-get-release" };

async function send(url, init = {}) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
  } catch (err) {
    throw new Error(`could not reach ${new URL(url).host}: ${err.cause?.message ?? err.message}`);
  }
}

/** Fetch that turns a failed response into an explanation. */
async function request(url, headers) {
  const res = await send(url, { headers });
  if (res.ok) return res;
  let hint = "";
  if (res.status === 404) hint = " If the repository is private, set GH_TOKEN to a token that can read it.";
  else if (res.status === 401) hint = " The token in GH_TOKEN was rejected.";
  else if (res.headers.get("x-ratelimit-remaining") === "0") {
    hint =
      " GitHub's API allowance for this network address is used up. Wait an hour, set GH_TOKEN, " +
      "or ask for an exact version (for example 1.4.0-beta.1), which does not use the API.";
  }
  throw new Error(`${new URL(url).host} answered ${res.status} ${res.statusText}.${hint}`);
}

/** The tag GitHub marks "Latest", read from where its /releases/latest link redirects. */
async function latestStableTag(web, repo) {
  const res = await send(`${web}/${repo}/releases/latest`, { headers: UA, redirect: "manual" });
  const m = /\/releases\/tag\/([^/?#]+)$/.exec(res.headers.get("location") ?? "");
  if (m) return decodeURIComponent(m[1]);
  if (res.status === 404) {
    throw new Error(`${repo} was not found. If the repository is private, set GH_TOKEN to a token that can read it.`);
  }
  throw new Error(`${repo} has no stable release yet. See what exists with: node get-release.mjs --list`);
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(usage());
    return;
  }

  const repo = opts.repo ?? process.env.XIERO_NEXUS_REPO ?? DEFAULT_REPO;
  const api = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");
  const web = (process.env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/+$/, "");
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const auth = token ? { authorization: `Bearer ${token}` } : {};
  const platform = `${process.platform}-${process.arch}`;

  // Newest 100 releases; plenty for choosing the newest of a channel.
  const listReleases = async () =>
    (
      await request(`${api}/repos/${repo}/releases?per_page=100`, {
        ...UA,
        ...auth,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      })
    ).json();

  if (opts.list) {
    const rows = (await listReleases()).filter((r) => !r.draft);
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
        `  ${r.tag_name.padEnd(22)} ${labelOfTag(r.tag_name).padEnd(11)} ${(r.published_at ?? "").slice(0, 10).padEnd(12)} ${nodes.join(", ") || "(no bundle for this platform)"}`,
      );
    }
    return;
  }

  const wanted = String(opts.want).toLowerCase();
  const isChannel = Object.hasOwn(STABILITY, wanted);
  const isDev = wanted === "dev" || wanted === DEV_TAG;
  const exactVersion = String(opts.want).replace(/^v/i, "");
  if (!isChannel && !isDev && !SEMVER.test(exactVersion)) {
    throw new UsageError(`"${opts.want}" is not a channel (stable, rc, beta, alpha, dev) or a version such as 1.4.0-beta.1`);
  }

  // 1. Which release? With a token everything goes through the API (the only
  //    way into a private repository). Without one, only a pre-release channel
  //    needs the API; the other answers are already known or one redirect away.
  let tag;
  let apiAssets = null; // file name → API URL, in token mode
  if (token || (isChannel && wanted !== "stable")) {
    const releases = await listReleases();
    const release = pickRelease(releases, opts.want);
    if (!release) {
      const tags = releases.filter((r) => !r.draft).map((r) => r.tag_name);
      throw new Error(
        `no release matches "${opts.want}" in ${repo}. ` +
          (tags.length ? `Available: ${tags.join(", ")}.` : "It has no releases yet."),
      );
    }
    tag = release.tag_name;
    if (token) apiAssets = new Map(release.assets.map((a) => [a.name, a.url]));
  } else if (isDev) {
    tag = DEV_TAG;
  } else if (isChannel) {
    tag = await latestStableTag(web, repo);
  } else {
    tag = `v${exactVersion}`;
  }

  // 2. The checksum file, which is also the list of bundles in the release.
  const downloads = `${web}/${repo}/releases/download/${encodeURIComponent(tag)}`;
  const binary = { ...UA, ...auth, accept: "application/octet-stream" };
  let sumsText;
  if (apiAssets) {
    if (!apiAssets.has("SHA256SUMS.txt")) {
      throw new Error(`${tag} has no SHA256SUMS.txt, so the download cannot be checked.`);
    }
    sumsText = await (await request(apiAssets.get("SHA256SUMS.txt"), binary)).text();
  } else {
    const res = await send(`${downloads}/SHA256SUMS.txt`, { headers: UA });
    if (res.status === 404) {
      throw new Error(
        `there is no release ${tag} in ${repo}. See ${web}/${repo}/releases, or run: node get-release.mjs --list\n` +
          "  If the repository is private, set GH_TOKEN to a token that can read it.",
      );
    }
    if (!res.ok) throw new Error(`${new URL(downloads).host} answered ${res.status} ${res.statusText}.`);
    sumsText = await res.text();
  }

  const sums = parseChecksums(sumsText);
  const wantedAsset = assetName(platform, opts.node);
  const expected = sums.get(wantedAsset);
  if (!expected || (apiAssets && !apiAssets.has(wantedAsset))) {
    const have = [...sums.keys()].filter((n) => n.endsWith(".zip"));
    throw new Error(
      `${tag} has no bundle for ${platform} with Node.js ${opts.node} (${wantedAsset}).\n` +
        `  Bundles in that release: ${have.join(", ") || "none"}.\n` +
        "  Use --node <major> to pick one of those and run it with that Node.js version, or build from source (see RELEASING.md).",
    );
  }

  // 3. The bundle itself.
  console.log(`Xiero Nexus AI ${tag} (${labelOfTag(tag)}) for ${platform}, Node.js ${opts.node}`);
  console.log(`Downloading ${wantedAsset}…`);
  const zipResponse = apiAssets
    ? await request(apiAssets.get(wantedAsset), binary)
    : await request(`${downloads}/${wantedAsset}`, UA);
  const zip = Buffer.from(await zipResponse.arrayBuffer());

  const actual = createHash("sha256").update(zip).digest("hex");
  if (expected !== actual) {
    throw new Error(
      `checksum mismatch for ${wantedAsset}: expected ${expected}, got ${actual}. Nothing was saved; try again.`,
    );
  }

  const outDir = resolve(opts.out);
  mkdirSync(outDir, { recursive: true });
  const fileName = `xiero-nexus-ai-${tag}-${platform}-node${opts.node}.zip`;
  const target = resolve(outDir, fileName);
  writeFileSync(target, zip);

  console.log(`Checksum verified (sha256 ${actual.slice(0, 12)}…, ${(zip.length / 1024 / 1024).toFixed(1)} MB)`);
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
