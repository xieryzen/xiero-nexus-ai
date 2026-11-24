/**
 * What a runner hands back, read with care, and how long a program may run.
 * Pure, so that it can be tested without a runner.
 */
import { isPackage, matchesPattern } from "../result/kinds";
import { validateWorkspacePath } from "./paths";

/** A file the program left behind and the runner handed back. */
export interface ExecKept {
  path: string;
  data: Buffer;
}
/** The longest one kept file, and all of one run together. */
export const KEEP_MAX_FILE_BYTES = 48 * 1024 * 1024;
export const KEEP_MAX_TOTAL_BYTES = 96 * 1024 * 1024;
export const KEEP_MAX_FILES = 12;

/**
 * The longest a program may run: two minutes, unless SANDBOX_MAX_SECONDS says
 * otherwise. A runner that builds Java needs more (its first build fetches
 * what it is built with); a runner never runs a program longer than its own
 * limit, whatever is asked of it.
 */
export function maxTimeoutMs(setting: string | undefined = process.env.SANDBOX_MAX_SECONDS): number {
  const seconds = Number(setting);
  if (!setting || !Number.isFinite(seconds)) return 120_000;
  return Math.min(Math.max(Math.round(seconds), 10), 3600) * 1000;
}

/**
 * What a runner handed back, read with care: a runner runs code nobody
 * checked, so a path it names is held to the rules of the workspace, a file
 * has to fit a pattern that was asked for, and nothing is larger than the
 * limits.
 */
export function readKept(raw: unknown, patterns: readonly string[]): { kept: ExecKept[]; notKept: { path: string; reason: string }[] } {
  const kept: ExecKept[] = [];
  const notKept: { path: string; reason: string }[] = [];
  let total = 0;
  for (const item of Array.isArray(raw) ? raw.slice(0, 200) : []) {
    const one = item as { path?: unknown; base64?: unknown };
    if (typeof one?.path !== "string" || typeof one.base64 !== "string") continue;
    let path: string;
    try {
      path = validateWorkspacePath(one.path);
    } catch {
      continue;
    }
    if (!patterns.some((pattern) => matchesPattern(pattern, path)) || !isPackage(path)) continue;
    if (kept.some((k) => k.path === path)) continue;
    if (kept.length >= KEEP_MAX_FILES) {
      notKept.push({ path, reason: `more than ${KEEP_MAX_FILES} files` });
      continue;
    }
    const data = Buffer.from(one.base64, "base64");
    if (data.length > KEEP_MAX_FILE_BYTES) {
      notKept.push({ path, reason: `larger than ${Math.round(KEEP_MAX_FILE_BYTES / (1024 * 1024))} MB` });
      continue;
    }
    if (total + data.length > KEEP_MAX_TOTAL_BYTES) {
      notKept.push({ path, reason: `more than ${Math.round(KEEP_MAX_TOTAL_BYTES / (1024 * 1024))} MB together` });
      continue;
    }
    total += data.length;
    kept.push({ path, data });
  }
  return { kept, notKept };
}

export function readNotKept(raw: unknown): { path: string; reason: string }[] {
  const out: { path: string; reason: string }[] = [];
  for (const item of Array.isArray(raw) ? raw.slice(0, 50) : []) {
    const one = item as { path?: unknown; reason?: unknown };
    if (typeof one?.path === "string" && typeof one.reason === "string") {
      out.push({ path: one.path.slice(0, 256), reason: one.reason.slice(0, 200) });
    }
  }
  return out;
}

