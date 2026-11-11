/**
 * Build/version metadata. Values are inlined at build time by next.config.mjs.
 * Dependency-free so it is safe on both server and client, and unit-testable.
 */
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";
export const BUILD_SHA = process.env.NEXT_PUBLIC_BUILD_SHA ?? "";

export type ReleaseChannel = "stable" | "rc" | "beta" | "alpha" | "prerelease";

/**
 * Release channel implied by a semver string:
 *   1.4.0          → stable
 *   1.4.0-rc.1     → rc
 *   1.4.0-beta.2   → beta
 *   1.4.0-alpha.0  → alpha
 *   anything else with a prerelease suffix → prerelease
 */
export function releaseChannel(version: string = APP_VERSION): ReleaseChannel {
  const dash = version.indexOf("-");
  if (dash === -1) return "stable";
  const pre = version.slice(dash + 1).toLowerCase();
  if (pre.startsWith("rc")) return "rc";
  if (pre.startsWith("beta")) return "beta";
  if (pre.startsWith("alpha")) return "alpha";
  return "prerelease";
}
