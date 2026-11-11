import "server-only";
import { AppError, sanitizeUpstreamError } from "@/lib/errors";
import { safeFetch } from "@/lib/http-client";
import { DEFAULT_ALLOWED_COMMANDS, parseCommand } from "./command";

export interface ExecFile {
  path: string;
  content: string;
}
export interface ExecInput {
  files: ExecFile[];
  command: string;
  timeoutMs: number;
}
export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface Executor {
  readonly enabled: boolean;
  readonly allowedCommands: string[];
  run(input: ExecInput): Promise<ExecResult>;
}

function allowedCommands(): string[] {
  const raw = process.env.SANDBOX_ALLOWED_COMMANDS;
  if (!raw) return DEFAULT_ALLOWED_COMMANDS;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Safe default: on-host execution is intentionally NOT supported. */
class DisabledExecutor implements Executor {
  readonly enabled = false;
  readonly allowedCommands = allowedCommands();
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
  constructor(
    private url: string,
    private token: string | undefined,
    private host: string,
  ) {}

  async run(input: ExecInput): Promise<ExecResult> {
    // Defense in depth: allowlist + reject shell metacharacters before sending.
    parseCommand(input.command, this.allowedCommands);

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
          timeoutMs: input.timeoutMs,
        }),
      },
      { timeoutMs: input.timeoutMs + 5000, allowHosts: [this.host] },
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
    const json = (await res.json()) as Partial<ExecResult>;
    return {
      exitCode: typeof json.exitCode === "number" ? json.exitCode : null,
      stdout: typeof json.stdout === "string" ? json.stdout : "",
      stderr: typeof json.stderr === "string" ? json.stderr : "",
      durationMs: typeof json.durationMs === "number" ? json.durationMs : 0,
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
