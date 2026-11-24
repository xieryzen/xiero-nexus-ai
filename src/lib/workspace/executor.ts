import "server-only";
import { AppError, sanitizeUpstreamError } from "@/lib/errors";
import { safeFetch } from "@/lib/http-client";
import { DEFAULT_ALLOWED_COMMANDS, parseCommand } from "./command";
import { KEEP_MAX_FILES, KEEP_MAX_FILE_BYTES, KEEP_MAX_TOTAL_BYTES, maxTimeoutMs, readKept, readNotKept, type ExecKept } from "./kept";

export { KEEP_MAX_FILES, KEEP_MAX_FILE_BYTES, KEEP_MAX_TOTAL_BYTES, maxTimeoutMs, readKept, type ExecKept };

export interface ExecFile {
  path: string;
  content: string;
}
export interface ExecInput {
  files: ExecFile[];
  command: string;
  timeoutMs: number;
  /**
   * Patterns of paths: the files the program leaves behind that fit one are
   * handed back with its output (v1.12). A runner that does not know of this
   * hands nothing back.
   */
  keep?: string[];
}
export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** The program was stopped because its time was up. */
  timedOut: boolean;
  kept: ExecKept[];
  /** Files that fit a pattern and were not handed back, each with the reason. */
  notKept: { path: string; reason: string }[];
}

export interface Executor {
  readonly enabled: boolean;
  readonly allowedCommands: string[];
  /** The longest a program may run. */
  readonly maxTimeoutMs: number;
  run(input: ExecInput): Promise<ExecResult>;
}

/** How long a request may wait at a runner that is busy with others, before its own time starts. */
const QUEUE_WAIT_MS = 5 * 60_000;

function allowedCommands(): string[] {
  const raw = process.env.SANDBOX_ALLOWED_COMMANDS;
  if (!raw) return DEFAULT_ALLOWED_COMMANDS;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Safe default: on-host execution is intentionally NOT supported. */
class DisabledExecutor implements Executor {
  readonly enabled = false;
  readonly allowedCommands = allowedCommands();
  readonly maxTimeoutMs = maxTimeoutMs();
  async run(): Promise<ExecResult> {
    throw new AppError(
      400,
      "execution_disabled",
      "Code execution is not configured. Set SANDBOX_URL to an isolated runner — " +
        "on-host execution is intentionally disabled for safety.",
    );
  }
}

/** Executes against an external, isolated sandbox runner over HTTP. */
class HttpSandboxExecutor implements Executor {
  readonly enabled = true;
  readonly allowedCommands = allowedCommands();
  readonly maxTimeoutMs = maxTimeoutMs();
  constructor(
    private url: string,
    private token: string | undefined,
    private host: string,
  ) {}

  async run(input: ExecInput): Promise<ExecResult> {
    // Defense in depth: allowlist + reject shell metacharacters before sending.
    parseCommand(input.command, this.allowedCommands);
    const timeoutMs = Math.min(Math.max(input.timeoutMs, 1000), this.maxTimeoutMs);
    const keep = input.keep ?? [];

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.token) headers["authorization"] = `Bearer ${this.token}`;

    const res = await safeFetch(
      `${this.url.replace(/\/+$/, "")}/run`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          files: input.files,
          command: input.command,
          timeoutMs,
          ...(keep.length > 0
            ? { keep, keepMaxFiles: KEEP_MAX_FILES, keepMaxFileBytes: KEEP_MAX_FILE_BYTES, keepMaxTotalBytes: KEEP_MAX_TOTAL_BYTES }
            : {}),
          // A long build says nothing for minutes. A runner that knows of
          // this answers at once and keeps the connection alive until the
          // program has ended; what went wrong is then in the answer itself.
          stream: true,
        }),
      },
      { timeoutMs: timeoutMs + QUEUE_WAIT_MS + 5000, allowHosts: [this.host] },
    );
    if (!res.ok) {
      let detail = "";
      try {
        detail = await res.text();
      } catch {
        /* ignore */
      }
      throw new AppError(502, "sandbox_error", `Sandbox runner responded ${res.status}: ${sanitizeUpstreamError(detail)}`);
    }
    let json: Partial<ExecResult> & { error?: unknown; kept?: unknown; notKept?: unknown };
    try {
      // The spaces a runner sends while a program runs come before the answer.
      json = JSON.parse((await res.text()).trim()) as typeof json;
    } catch {
      throw new AppError(502, "sandbox_error", "The sandbox runner did not answer with a result");
    }
    if (typeof json.error === "string" && typeof json.exitCode !== "number" && json.exitCode !== null) {
      throw new AppError(502, "sandbox_error", `Sandbox runner: ${sanitizeUpstreamError(json.error)}`);
    }
    const handed = readKept(json.kept, keep);
    return {
      exitCode: typeof json.exitCode === "number" ? json.exitCode : null,
      stdout: typeof json.stdout === "string" ? json.stdout : "",
      stderr: typeof json.stderr === "string" ? json.stderr : "",
      durationMs: typeof json.durationMs === "number" ? json.durationMs : 0,
      timedOut: json.timedOut === true,
      kept: handed.kept,
      notKept: [...handed.notKept, ...readNotKept(json.notKept)],
    };
  }
}

export function getExecutor(): Executor {
  const url = process.env.SANDBOX_URL;
  if (!url) return new DisabledExecutor();
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return new DisabledExecutor();
  }
  return new HttpSandboxExecutor(url, process.env.SANDBOX_TOKEN, host);
}
