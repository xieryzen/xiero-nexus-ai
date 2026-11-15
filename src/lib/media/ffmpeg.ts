import "server-only";
import { spawn } from "node:child_process";
import { cached, runtime } from "../runtime";
import { parseProbe, type MediaInfo } from "./render-plan";

/**
 * Running ffmpeg, which joins clips into one video. It is not part of the
 * app: the server needs it installed, or FFMPEG_PATH set to the program.
 * Without it everything else works and joining says what is missing.
 */

export function ffmpegPath(): string {
  return process.env.FFMPEG_PATH?.trim() || "ffmpeg";
}

export interface FfmpegResult {
  code: number | null;
  /** The end of what the program printed. */
  stderr: string;
  timedOut: boolean;
}

const STDERR_KEEP = 8000;

/** Run ffmpeg with these arguments. Never through a shell. */
export function runFfmpeg(
  args: string[],
  opts: { timeoutMs: number; cwd?: string; isCancelled?: () => boolean },
): Promise<FfmpegResult> {
  return new Promise((resolve) => {
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watch);
      resolve({ code, stderr, timedOut });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(ffmpegPath(), args, {
        cwd: opts.cwd,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      stderr = err instanceof Error ? err.message : "spawn failed";
      resolve({ code: null, stderr, timedOut });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    const watch = setInterval(() => {
      if (opts.isCancelled?.()) child.kill("SIGKILL");
    }, 1000);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_KEEP);
    });
    child.on("error", (err) => {
      stderr = err.message;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

export interface FfmpegStatus {
  available: boolean;
  /** "7.0.2", when it could be read. */
  version: string | null;
  /** Can encode H.264 video, which joining needs. */
  h264: boolean;
  /** Can burn subtitles in. */
  subtitles: boolean;
}

async function detect(): Promise<FfmpegStatus> {
  const none: FfmpegStatus = { available: false, version: null, h264: false, subtitles: false };
  const version = await runFfmpegStdout(["-hide_banner", "-version"]);
  if (version === null) return none;
  const [encoders, filters] = await Promise.all([
    runFfmpegStdout(["-hide_banner", "-encoders"]),
    runFfmpegStdout(["-hide_banner", "-filters"]),
  ]);
  return {
    available: true,
    version: version.match(/ffmpeg version (\S+)/)?.[1] ?? null,
    h264: /\blibx264\b/.test(encoders ?? ""),
    subtitles: /^\s*\S+\s+ass\s/m.test(filters ?? ""),
  };
}

function runFfmpegStdout(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(ffmpegPath(), args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (out.length < 400_000) out += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out : null);
    });
  });
}

/** What this server's ffmpeg can do. Looked up once and kept for ten minutes. */
export function ffmpegStatus(): Promise<FfmpegStatus> {
  return cached(`ffmpeg:${ffmpegPath()}`, 10 * 60_000, detect);
}

/** The last answer of {@link ffmpegStatus}, without waiting for a new one. */
export function ffmpegStatusNow(): FfmpegStatus | null {
  const hit = runtime().cache.get(`ffmpeg:${ffmpegPath()}`);
  return hit ? (hit.value as FfmpegStatus) : null;
}

/** What a file holds: its length, its frame size, whether it has sound. */
export async function probeFile(path: string, format: string | null): Promise<MediaInfo | null> {
  const args = ["-hide_banner", "-nostdin", "-protocol_whitelist", "file"];
  if (format) {
    args.push("-f", format);
    if (format === "image2") args.push("-pattern_type", "none");
  }
  args.push("-i", path);
  // Without an output ffmpeg prints what the file holds and exits with an error.
  const result = await runFfmpeg(args, { timeoutMs: 20_000 });
  if (result.code === null || result.timedOut) return null;
  if (!/Stream #/.test(result.stderr)) return null;
  return parseProbe(result.stderr);
}
