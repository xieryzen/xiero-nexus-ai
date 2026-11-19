/**
 * Servers over SSH: the rules that need no connection and no database. Pure:
 * used by the server, by the pages and by the tests.
 *
 * An owner registers a machine. A project names the machines it works on,
 * and an agent that has the tool `run_on_server` runs commands there. One
 * connection per run and machine is opened with the first command and stays
 * open, kept alive, until the run has ended (sessions.ts). Every command is
 * written down with how it ended.
 */

export const SERVER_TOOL = "run_on_server";

export const SERVER_NAME_MAX = 40;
export const SERVER_NOTES_MAX = 400;
/** Machines one project may name. */
export const SERVERS_PER_PROJECT = 5;
/** Longest command line. A file is written with a here-document inside this. */
export const COMMAND_MAX_CHARS = 16_000;

export const DEFAULT_TIMEOUT_SECONDS = 300;
export const MIN_TIMEOUT_SECONDS = 5;
export const MAX_TIMEOUT_SECONDS = 3600;

/** How often an open connection says that it is still there. */
export const KEEPALIVE_INTERVAL_MS = 15_000;
/** Unanswered keep-alives after which a connection counts as lost. */
export const KEEPALIVE_COUNT_MAX = 4;
/** How long signing in may take. */
export const CONNECT_TIMEOUT_MS = 20_000;
/** Waits before a connection is tried again, in turn: three tries in all. */
export const RECONNECT_WAITS_MS = [2_000, 5_000] as const;
/** Commands of one run that run on one machine at the same time; more wait their turn. */
export const CHANNELS_AT_ONCE = 4;

/** How much of what a command printed the agent reads, per stream: the start and the end. */
export const STDOUT_SHOWN = { head: 2_000, tail: 5_000 } as const;
export const STDERR_SHOWN = { head: 800, tail: 2_200 } as const;
/** How much of it is kept in the log. */
export const LOG_OUTPUT_CHARS = 6_000;
/** Commands kept in the log per machine; older ones make way. */
export const LOG_KEEP = 5_000;

/** Whose projects may work on a machine: an owner's always, an administrator's when the owner says so. */
export const SERVER_ACCESS = ["owners", "admins"] as const;
export type ServerAccess = (typeof SERVER_ACCESS)[number];

/** How a command on a machine ended, or why it was not started. */
export const SERVER_COMMAND_STATES = ["ok", "failed", "timeout", "cancelled", "lost", "refused"] as const;

// ─── Who ─────────────────────────────────────────────────────────────────────

/** What anyone else is told who tries. */
export const ONLY_OWNER = "Only an owner registers, changes and checks servers";

/** Only an owner registers, changes and removes a machine. */
export function managesServers(role: string | null | undefined): boolean {
  return role === "owner";
}

/**
 * Whether the projects of an account with this role may work on a machine.
 * An owner's always may; an administrator's when the owner opened the
 * machine to administrators; a user's never: whoever can tell an agent what
 * to do there can do anything the registered account can.
 */
export function mayUseServer(role: string | null | undefined, access: string): boolean {
  if (role === "owner") return true;
  return role === "admin" && access === "admins";
}

// ─── What is registered ──────────────────────────────────────────────────────

/** A machine's name as it is kept: lower case. Null when it is not a name. */
export function serverName(raw: string): string | null {
  const name = raw.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]*$/.test(name) && name.length <= SERVER_NAME_MAX ? name : null;
}

/** Why this is not a host, or null: a name or an address, and nothing around it. */
export function hostProblem(raw: string): string | null {
  const host = raw.trim();
  if (!host) return "Enter the machine's name or address.";
  if (host.length > 253) return "That is too long for a host name.";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) return 'Enter the host alone, without "ssh://".';
  if (host.includes("@")) return 'Enter the host alone: the account goes in "Username".';
  if (/\s/.test(host)) return "A host has no spaces.";
  const bare = host.replace(/^\[(.*)\]$/, "$1");
  if (bare.includes(":")) {
    // Only an IPv6 address has colons: hex groups, two colons or more.
    const v6 = /^[0-9a-f:.]+$/i.test(bare) && (bare.match(/:/g) ?? []).length >= 2 && bare.length <= 45;
    return v6 ? null : 'Enter the host alone: the port goes in "Port".';
  }
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(bare)) return "That does not look like a host name or an address.";
  return null;
}

/** The host as a connection takes it: an IPv6 address without its brackets. */
export function hostForConnection(host: string): string {
  return host.trim().replace(/^\[(.*)\]$/, "$1");
}

/** Why this is not an account name on a machine, or null. */
export function usernameProblem(raw: string): string | null {
  const name = raw.trim();
  if (!name) return "Enter the account to sign in as.";
  if (name.length > 64) return "That is too long for an account name.";
  return /^[A-Za-z0-9_][A-Za-z0-9_.@-]*\$?$/.test(name) ? null : "That does not look like an account name.";
}

/** A port, or null. */
export function portOf(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/** Whether a text looks like a private key file: PEM, or OpenSSH's own format. */
export function looksLikePrivateKey(text: string): boolean {
  return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]+-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(text);
}

// ─── A command ───────────────────────────────────────────────────────────────

/** A text inside single quotes for a shell. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** What starts the line a command's own shell prints first, to say which processes are its own. */
export const PID_MARK = "__xn_pid__:";

/**
 * The line that is sent to the machine for a command.
 *
 * The command is run by bash where there is one, else by sh, whatever shell
 * the account signs in with. The shell first says which process group it is
 * in (from /proc, else from ps, else its own number), so that the command
 * and everything it started can be ended when its time is up. Nothing is
 * asked of a person: there is no terminal, the input is empty (a program
 * that reads it finds its end at once), and package tools are told not to
 * ask.
 */
export function remoteCommand(command: string): string {
  const run =
    'g=$(cut -d" " -f5 "/proc/$$/stat" 2>/dev/null) || g=$(ps -o pgid= -p $$ 2>/dev/null | tr -d " "); ' +
    `echo "${PID_MARK}\${g:-$$}" >&2; export DEBIAN_FRONTEND=noninteractive; ` +
    'if command -v bash >/dev/null 2>&1; then exec bash -c "$0" </dev/null; else exec sh -c "$0" </dev/null; fi';
  return `sh -c ${shellQuote(run)} ${shellQuote(command)}`;
}

/**
 * The process a command said it is, and its error output without that line.
 * `whole`: the output is complete. While it is still coming in, the line
 * counts only once it has ended, so that half a number is not taken for one.
 */
export function takePid(stderr: string, whole = true): { pid: number | null; stderr: string } {
  const match = new RegExp(`(^|\\n)${PID_MARK}(\\d{1,10})${whole ? "\\r?\\n?" : "\\r?\\n"}`).exec(stderr);
  if (!match) return { pid: null, stderr };
  const pid = Number(match[2]);
  return {
    pid: Number.isInteger(pid) && pid > 1 ? pid : null,
    stderr: stderr.slice(0, match.index) + (match[1] ?? "") + stderr.slice(match.index + match[0].length),
  };
}

/**
 * The line that ends a command and what it started: the process group it
 * said it is in, or that one process where the number names no group. They
 * are asked to end, given two seconds, and ended if they are still there.
 * The line is over as soon as nothing of them is left.
 */
export function killCommand(pid: number): string {
  // Written the way every sh takes it: dash refuses "--" before a negative number.
  const each = (signal: string) => `kill -${signal} -${pid} 2>/dev/null || kill -${signal} ${pid} 2>/dev/null`;
  const script =
    `${each("TERM")}; n=0; while [ $n -lt 10 ]; do ${each("0")} || exit 0; ` +
    `sleep 0.2 2>/dev/null || sleep 1; n=$((n+1)); done; ${each("KILL")}; true`;
  return `sh -c ${shellQuote(script)}`;
}

/** Seconds a command may take: what was asked, within the limits. */
export function timeoutSeconds(asked: unknown): number {
  if (asked === undefined || asked === null || asked === "") return DEFAULT_TIMEOUT_SECONDS;
  const n = typeof asked === "number" ? asked : Number(asked);
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_SECONDS;
  return Math.min(MAX_TIMEOUT_SECONDS, Math.max(MIN_TIMEOUT_SECONDS, Math.round(n)));
}

// ─── What a command printed ──────────────────────────────────────────────────

/**
 * Keeps the start and the end of a stream that can be any length, and counts
 * the rest: a build that prints for an hour does not fill the memory.
 */
export class OutputBuffer {
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  /** Everything that came in. */
  bytes = 0;
  /** What is in neither the start nor the end. */
  dropped = 0;

  constructor(
    private readonly headMax = 16 * 1024,
    private readonly tailMax = 48 * 1024,
  ) {}

  add(chunk: Buffer): void {
    this.bytes += chunk.length;
    let rest = chunk;
    if (this.headBytes < this.headMax) {
      const take = rest.subarray(0, this.headMax - this.headBytes);
      this.head.push(take);
      this.headBytes += take.length;
      rest = rest.subarray(take.length);
    }
    if (rest.length === 0) return;
    this.tail.push(rest);
    this.tailBytes += rest.length;
    while (this.tailBytes > this.tailMax && this.tail.length > 0) {
      const first = this.tail[0]!;
      const over = this.tailBytes - this.tailMax;
      if (first.length <= over) {
        this.tail.shift();
        this.tailBytes -= first.length;
        this.dropped += first.length;
      } else {
        this.tail[0] = first.subarray(over);
        this.tailBytes -= over;
        this.dropped += over;
      }
    }
  }

  /** The start and the end, with a line between them that says what is missing. */
  text(): string {
    const head = Buffer.concat(this.head).toString("utf8");
    const tail = Buffer.concat(this.tail).toString("utf8");
    if (this.dropped === 0) return head + tail;
    return `${head}\n[… ${this.dropped} bytes in between were not kept …]\n${tail}`;
  }
}

/**
 * What a program printed, as text to read: without the colour and cursor
 * codes of a terminal, with a line that was rewritten in place (a progress
 * bar) reduced to what it showed last, and without other control characters.
 */
export function cleanOutput(text: string): string {
  return (
    text
      // Colours, cursor moves, window titles.
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g, "")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => {
        const trimmed = line.replace(/\r+$/, "");
        const at = trimmed.lastIndexOf("\r");
        return at === -1 ? trimmed : trimmed.slice(at + 1);
      })
      .join("\n")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
  );
}

/** The start and the end of a text that is too long, with what was cut said between them. */
export function clipMiddle(text: string, shown: { head: number; tail: number }): string {
  if (text.length <= shown.head + shown.tail) return text;
  const cut = text.length - shown.head - shown.tail;
  return `${text.slice(0, shown.head)}\n[… ${cut} characters cut …]\n${text.slice(-shown.tail)}`;
}

/** The end of a text, with what was cut said before it. */
export function clipStart(text: string, max: number): string {
  return text.length <= max ? text : `[… ${text.length - max} characters before this were cut]\n${text.slice(-max)}`;
}

export type CommandOutcome = "ok" | "failed" | "timeout" | "cancelled" | "lost";

export interface CommandResult {
  outcome: CommandOutcome;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Seconds the command was allowed. */
  timeoutSeconds: number;
  /** Whether ending it on the machine was asked for, when it was stopped here. */
  ended?: boolean;
  /** Whether the command's own shell said which processes are its own: the machine ran the line with sh. */
  shell?: boolean;
}

/** How long something took, in words: "0.4 s", "42 s", "3 min 5 s". */
export function took(ms: number): string {
  if (ms < 10_000) return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const rest = seconds % 60;
  return rest === 0 ? `${Math.floor(seconds / 60)} min` : `${Math.floor(seconds / 60)} min ${rest} s`;
}

/** The first line of what an agent reads of a command: how it ended. */
export function outcomeLine(server: string, result: CommandResult): string {
  const time = took(result.durationMs);
  switch (result.outcome) {
    case "ok":
      return `[${server}] exit code 0, ${time}`;
    case "failed":
      return result.signal
        ? `[${server}] ended by signal ${result.signal}, ${time}`
        : `[${server}] exit code ${result.exitCode ?? "unknown"}, ${time}`;
    case "timeout":
      return (
        `[${server}] stopped: it was still running after the ${result.timeoutSeconds} s it was allowed (timeout_seconds). ` +
        (result.ended
          ? "It was ended on the server."
          : "Ending it on the server could not be confirmed: look whether it still runs.") +
        " For work that takes longer, allow more time, or start it in the background (nohup … &) and look at it with later calls."
      );
    case "cancelled":
      return `[${server}] stopped after ${time}: the run was stopped.`;
    case "lost":
      return (
        `[${server}] the connection was lost after ${time}, while the command ran. Whether it finished is not known. ` +
        "The next call connects again: look at what is there before you repeat it."
      );
  }
}

/** What an agent reads of a command: how it ended and what it printed. */
export function resultText(server: string, result: CommandResult): string {
  const out = clipMiddle(cleanOutput(result.stdout).replace(/\s+$/, ""), STDOUT_SHOWN);
  const err = clipMiddle(cleanOutput(result.stderr).replace(/\s+$/, ""), STDERR_SHOWN);
  return [
    outcomeLine(server, result),
    out ? `stdout:\n${out}` : "stdout: (empty)",
    err ? `stderr:\n${err}` : "stderr: (empty)",
  ].join("\n");
}

/** What the log keeps of what a command printed: both streams, shortened to their end. */
export function logOutput(result: Pick<CommandResult, "stdout" | "stderr">): string {
  const out = cleanOutput(result.stdout).replace(/\s+$/, "");
  const err = cleanOutput(result.stderr).replace(/\s+$/, "");
  const half = Math.floor(LOG_OUTPUT_CHARS / 2);
  // What one stream does not need, the other may use.
  const outMax = Math.max(half, LOG_OUTPUT_CHARS - Math.min(err.length, half));
  const errMax = Math.max(half, LOG_OUTPUT_CHARS - Math.min(out.length, half));
  return [out ? clipStart(out, outMax) : "", err ? `stderr:\n${clipStart(err, errMax)}` : ""].filter(Boolean).join("\n");
}

/** A command on one line, shortened, for a progress note or a list. */
export function commandLabel(command: string, max = 80): string {
  const line = command.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// ─── What an agent is told ───────────────────────────────────────────────────

export interface ServerForAgent {
  name: string;
  username: string;
  notes: string | null;
}

/** The machines of a run, as the tool's description names them. */
export function serversLine(servers: readonly ServerForAgent[]): string {
  return servers
    .map((s) => `${s.name} (signed in as ${s.username}${s.notes ? `; ${s.notes.replace(/\s+/g, " ").trim()}` : ""})`)
    .join("; ");
}

/** What the tool says of itself to the model. */
export function toolDescription(servers: readonly ServerForAgent[]): string {
  return (
    "Run a shell command on a server of this project over SSH, and get its exit code and what it printed. " +
    "The connection stays open for the whole run: every call uses the same one, so there is nothing to sign in to. " +
    "Each call starts in the account's home directory with a new shell (bash where there is one): " +
    "a `cd` or a variable does not carry over, so write `cd /path && …` in one command. " +
    "Nobody is at a keyboard: a program that asks a question gets no answer, so pass the options that make it not ask (-y, --yes). " +
    "A command is ended when its time is up; for long work, set timeout_seconds, or start it with nohup in the background and look at it with later calls. " +
    "These are real machines: look before you change something, and say in your answer what you changed. " +
    `Servers: ${serversLine(servers)}.`
  );
}

export interface EarlierCommand {
  server: string;
  command: string;
  status: string;
  exitCode: number | null;
}

/**
 * What an agent is told when the task it starts on has already run commands:
 * an attempt before this one was interrupted, or the app was restarted. Those
 * commands are not undone by starting over.
 */
export function earlierNote(earlier: readonly EarlierCommand[], shown = 30): string {
  if (earlier.length === 0) return "";
  const last = earlier.slice(-shown);
  const lines = last.map((c, i) => {
    const how =
      c.status === "ok" ? "exit 0" : c.status === "failed" ? `exit ${c.exitCode ?? "?"}` : c.status === "refused" ? "not started" : c.status;
    return `${i + 1}. [${c.server}] ${how}: ${commandLabel(c.command, 160)}`;
  });
  return (
    `(Before this attempt, this task already ran ${earlier.length} command${earlier.length === 1 ? "" : "s"} on the server` +
    `${earlier.length > last.length ? `; the last ${last.length}` : ""}:\n${lines.join("\n")}\n` +
    "They are not undone. Look at what is there before you repeat one.)"
  );
}
