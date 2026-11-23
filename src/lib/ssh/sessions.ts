import "server-only";
import { Client } from "ssh2";
import type { Server } from "@/db/schema";
import { connectHostOf } from "../access/address";
import { AppError, sanitizeUpstreamError } from "../errors";
import { fingerprint, hostKeyLine, parseHostKey, sameHostKey } from "./host-key";
import {
  CHANNELS_AT_ONCE,
  CONNECT_TIMEOUT_MS,
  KEEPALIVE_COUNT_MAX,
  KEEPALIVE_INTERVAL_MS,
  OutputBuffer,
  RECONNECT_WAITS_MS,
  cleanOutput,
  hostForConnection,
  killCommand,
  logOutput,
  remoteCommand,
  takePid,
  took,
  type CommandOutcome,
  type CommandResult,
} from "./rules";
import { credentialsOf, getServer, logCommand, noteConnection } from "./servers";

/**
 * The connections to the machines agents work on.
 *
 * A run has one connection to each machine it uses. It is opened with the
 * first command, says every few seconds that it is still there, and stays
 * open while the run goes on: through the tasks that follow, through the
 * minutes in which a model thinks, through whatever else the run does. It is
 * closed when the run has ended, however it ended. When it is lost on the
 * way (the network, a restart of the machine), the next command opens it
 * again, and that is written down too.
 *
 * Kept on `globalThis`, like the rest of what is one per server process
 * (runtime.ts): the worker that executes runs and the request handlers are
 * built apart, and both look here.
 */

// ─── What can stand in the way ───────────────────────────────────────────────

export type ProblemKind =
  /** No connection: the name, the network, the port, or no answer in time. */
  | "unreachable"
  /** The machine showed another host key than the one that was accepted. */
  | "host_key"
  /** The machine did not take the password or the key. */
  | "sign_in"
  /** The private key cannot be read. */
  | "key"
  /** The machine opens no further session on the connection. */
  | "busy"
  /** The machine signs us in and does not run a command the way a machine with sh does. */
  | "shell"
  /** The machine is switched off here, or not registered any more. */
  | "off";

export class SshProblem extends Error {
  constructor(
    readonly kind: ProblemKind,
    /** For those who registered the machine: what happened, with what it said. */
    message: string,
    /** For an agent: the machine by its name, and whether trying again can help. */
    readonly forAgent: string,
    /** The host key the machine showed, when that is the problem. */
    readonly shownKey: string | null = null,
  ) {
    super(message);
    this.name = "SshProblem";
  }
}

function problemOf(err: unknown, name: string): SshProblem {
  if (err instanceof SshProblem) return err;
  const e = (err ?? {}) as { level?: string; code?: string; message?: string };
  const said = sanitizeUpstreamError(e.message ?? String(err), 200);
  const later = `"${name}" could not be reached just now. It was tried more than once; a later call tries again.`;
  if (e.level === "client-authentication") {
    return new SshProblem(
      "sign_in",
      "The machine did not accept the sign-in: the account, the password or the key is not what it expects.",
      `"${name}" did not accept the sign-in that is registered for it. Trying again does not help: an owner has to look at it on the Servers page.`,
    );
  }
  if (/Cannot parse privateKey|passphrase/i.test(said)) {
    return new SshProblem(
      "key",
      `The private key cannot be read: ${said.replace(/^Cannot parse privateKey:\s*/i, "")}.`,
      `The key that is registered for "${name}" cannot be read. An owner has to look at it on the Servers page.`,
    );
  }
  if (e.level === "client-timeout" || e.code === "ETIMEDOUT") {
    return new SshProblem("unreachable", "The machine did not answer in time.", later);
  }
  if (e.code === "ECONNREFUSED") {
    return new SshProblem("unreachable", "The machine refused the connection: nothing answers SSH on that port.", later);
  }
  if (e.code === "ENOTFOUND" || e.code === "EAI_AGAIN") {
    return new SshProblem("unreachable", "The name of the machine could not be found.", later);
  }
  if (e.code === "EHOSTUNREACH" || e.code === "ENETUNREACH") {
    return new SshProblem("unreachable", "The machine cannot be reached from here.", later);
  }
  return new SshProblem("unreachable", `The connection could not be made: ${said}.`, later);
}

// ─── One connection ──────────────────────────────────────────────────────────

export interface Target {
  /** The machine's name here, for what is said about it. */
  name: string;
  host: string;
  port: number;
  username: string;
  /** The host key that was accepted. A machine that shows another one is not signed in to. */
  hostKey: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

/** The ways a machine may prove a key of this type: so that it shows the key that was accepted, and no other of its keys. */
function hostKeyAlgorithms(type: string): string[] {
  return type === "ssh-rsa" ? ["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"] : [type];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How often an open connection says that it is still there. Every 15 seconds
 * holds a connection through the firewalls and routers that forget a quiet
 * one; SSH_KEEPALIVE_SECONDS (1 to 300) changes it for a network that needs
 * another pace.
 */
export function keepaliveMs(): number {
  const seconds = Number(process.env.SSH_KEEPALIVE_SECONDS);
  return Number.isFinite(seconds) && seconds >= 1 && seconds <= 300 ? Math.round(seconds * 1000) : KEEPALIVE_INTERVAL_MS;
}

/**
 * The host key a machine shows, as one line. Nothing is signed in to: the
 * connection is ended as soon as the key is there, before a password or a
 * key of ours is sent. So an owner can compare it before anything is
 * registered.
 */
export function readHostKey(host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let line: string | null = null;
    let shown = false;
    let settled = false;
    const end = (problem: unknown) => {
      if (settled) return;
      settled = true;
      try {
        client.end();
        client.destroy();
      } catch {
        // Already closed.
      }
      if (line) resolve(line);
      else if (shown) reject(new SshProblem("host_key", "The machine showed a host key of a kind this app does not know.", ""));
      else reject(problemOf(problem, host));
    };
    client.on("error", end);
    client.on("close", () => end(new SshProblem("unreachable", "The machine closed the connection before it showed its host key.", "")));
    try {
      client.connect({
        host: hostForConnection(host),
        port,
        username: "host-key",
        readyTimeout: CONNECT_TIMEOUT_MS,
        hostVerifier: (key: Buffer) => {
          shown = true;
          line = hostKeyLine(key);
          return false;
        },
      });
    } catch (err) {
      end(err);
    }
  });
}

/** A connection that is signed in, to a machine that showed the key that was accepted. */
function connect(target: Target): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let shown: string | null = null;
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      try {
        client.end();
        client.destroy();
      } catch {
        // Already closed.
      }
      if (shown && !sameHostKey(shown, target.hostKey)) {
        reject(
          new SshProblem(
            "host_key",
            `The machine showed another host key (${fingerprint(shown) ?? "unreadable"}) than the one that was accepted (${fingerprint(target.hostKey) ?? "none"}). ` +
              "Nothing was sent to it. If the machine was set up again, accept its new key; if not, something else answered in its place.",
            `"${target.name}" showed another host key than the one registered, so nothing was sent to it. Trying again does not help: an owner has to look at it on the Servers page.`,
            shown,
          ),
        );
        return;
      }
      reject(problemOf(err, target.name));
    };
    client.once("ready", () => {
      if (settled) return;
      settled = true;
      resolve(client);
    });
    // Both stay on the connection and do nothing once the sign-in is done:
    // a connection is never without someone who hears its errors.
    client.on("error", fail);
    client.on("close", () =>
      fail(
        new SshProblem(
          "unreachable",
          "The machine closed the connection before the sign-in was done.",
          `"${target.name}" could not be reached just now. A later call tries again.`,
        ),
      ),
    );
    const password = target.password;
    if (password !== undefined) {
      // A machine that asks for the password as a question gets it as the answer.
      client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => finish(prompts.map(() => password)));
    }
    const type = parseHostKey(target.hostKey)?.type;
    try {
      client.connect({
        host: hostForConnection(target.host),
        port: target.port,
        username: target.username,
        password,
        tryKeyboard: password !== undefined,
        privateKey: target.privateKey,
        passphrase: target.passphrase,
        readyTimeout: CONNECT_TIMEOUT_MS,
        keepaliveInterval: keepaliveMs(),
        keepaliveCountMax: KEEPALIVE_COUNT_MAX,
        ...(type ? { algorithms: { serverHostKey: hostKeyAlgorithms(type) as never } } : {}),
        hostVerifier: (key: Buffer) => {
          shown = hostKeyLine(key);
          return Boolean(shown && sameHostKey(shown, target.hostKey));
        },
      });
    } catch (err) {
      fail(err);
    }
  });
}

/**
 * The same, for a connection that is made now. A machine that someone other
 * than an owner handed over in a conversation is connected to only at an
 * address on the public internet (access/address.ts).
 */
async function checkedTarget(server: Server): Promise<Target> {
  const target = targetOf(server);
  if (!server.ownerId) return target;
  try {
    return { ...target, host: await connectHostOf(server) };
  } catch (err) {
    const said = err instanceof AppError ? err.message : "The address of the machine could not be checked.";
    throw new SshProblem("off", said, said);
  }
}

export function targetOf(server: Server): Target {
  return {
    name: server.name,
    host: server.host,
    port: server.port,
    username: server.username,
    hostKey: server.hostKey,
    ...credentialsOf(server),
  };
}

// ─── One command ─────────────────────────────────────────────────────────────

/** The command was not started: no session could be opened on the connection. */
class NotStarted extends Error {}

/** End a command on the machine. Resolves to whether the machine was asked. */
function endOnServer(client: Client, pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    const guard = setTimeout(() => resolve(false), 10_000);
    try {
      client.exec(killCommand(pid), (err, stream) => {
        if (err) {
          clearTimeout(guard);
          resolve(false);
          return;
        }
        stream.on("close", () => {
          clearTimeout(guard);
          resolve(true);
        });
        stream.on("error", () => undefined);
        stream.stderr.on("error", () => undefined);
        stream.resume();
        stream.stderr.resume();
        stream.end();
      });
    } catch {
      clearTimeout(guard);
      resolve(false);
    }
  });
}

interface ExecOptions {
  /** The line as the machine gets it. */
  line: string;
  timeoutMs: number;
  isCancelled?: () => boolean;
  /** Called every few seconds while the command runs, with how long it has run. */
  onProgress?: (elapsedMs: number) => void;
}

const PROGRESS_EVERY_MS = 10_000;

function execOn(client: Client, opts: ExecOptions): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let opened = false;
    const open = (err: Error | undefined, stream: import("ssh2").ClientChannel) => {
      if (err) {
        reject(new NotStarted(err.message));
        return;
      }
      opened = true;
      const out = new OutputBuffer();
      const errors = new OutputBuffer();
      let pid: number | null = null;
      let done = false;
      let stopped: "timeout" | "cancelled" | null = null;
      let ended = false;
      /** Ending it on the machine, once that was asked for. */
      let ending: Promise<boolean> | null = null;
      let lastProgress = started;
      const whenDone: (() => void)[] = [];

      const finish = (outcome: CommandOutcome, exitCode: number | null, signal: string | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(tick);
        client.removeListener("close", lost);
        for (const tell of whenDone.splice(0)) tell();
        const said = takePid(errors.text());
        resolve({
          outcome,
          exitCode,
          signal,
          stdout: out.text(),
          stderr: said.stderr,
          durationMs: Date.now() - started,
          timeoutSeconds: Math.round(opts.timeoutMs / 1000),
          ended,
          shell: said.pid !== null,
        });
      };
      const lost = () => finish(stopped ?? "lost", null, null);
      /** Resolves when the command is over, or after this long. */
      const over = (ms: number) =>
        new Promise<void>((settle) => {
          if (done) return settle();
          const timer = setTimeout(settle, ms);
          whenDone.push(() => {
            clearTimeout(timer);
            settle();
          });
        });
      const sendSignal = (name: "TERM" | "KILL") => {
        try {
          stream.signal(name);
        } catch {
          // The channel is gone already.
        }
      };
      const stop = async (why: "timeout" | "cancelled") => {
        if (done || stopped) return;
        stopped = why;
        ending = pid !== null ? endOnServer(client, pid) : Promise.resolve(false);
        ended = await ending;
        if (!ended && !done) {
          // The line that ends it could not be run: the machine opens no
          // further session, or the command never said which processes are
          // its own. It is asked through the command's own channel instead,
          // which an SSH server of the last years passes on to the command
          // and what it started. Whether it did is not known.
          sendSignal("TERM");
          await over(2_000);
          if (!done) {
            sendSignal("KILL");
            await over(500);
          }
        }
        try {
          stream.close();
        } catch {
          // The channel is gone already.
        }
        // The machine says "closed" in answer. When it does not, this is over all the same.
        setTimeout(() => finish(why, null, null), 5_000);
      };

      // What goes wrong with the channel ends in "close", which is heard below.
      stream.on("error", () => undefined);
      stream.stderr.on("error", () => undefined);
      stream.on("data", (chunk: Buffer) => out.add(chunk));
      stream.stderr.on("data", (chunk: Buffer) => {
        errors.add(chunk);
        if (pid === null) pid = takePid(errors.text(), false).pid;
      });
      stream.on("close", (code: number | null | undefined, signal: string | null | undefined) => {
        const exit = typeof code === "number" ? code : null;
        const why = stopped;
        // A command that was stopped ends as soon as it is told to: what is
        // said about it waits for the line that told it, so that it is known
        // whether the machine was asked.
        if (why && ending) void ending.then(() => finish(why, exit, signal ?? null));
        else finish(exit === 0 ? "ok" : "failed", exit, signal ?? null);
      });
      client.once("close", lost);
      // Our side of the channel is left open: a signal can be sent through it
      // only as long as it is (stop, above). Nobody is there to answer all
      // the same: the line gives the command an empty input (remoteCommand).

      const timer = setTimeout(() => void stop("timeout"), opts.timeoutMs);
      const tick = setInterval(() => {
        if (opts.isCancelled?.()) {
          void stop("cancelled");
          return;
        }
        const now = Date.now();
        if (now - lastProgress >= PROGRESS_EVERY_MS) {
          lastProgress = now;
          opts.onProgress?.(now - started);
        }
      }, 1_000);
    };
    try {
      client.exec(opts.line, open);
    } catch (err) {
      if (!opened) reject(new NotStarted(err instanceof Error ? err.message : String(err)));
    }
  });
}

// ─── The connections of the runs ─────────────────────────────────────────────

export interface SessionContext {
  projectId: string | null;
  projectTitle: string | null;
  /** The account the run works for. */
  userId: string | null;
}

interface Session {
  runId: string;
  serverId: string;
  serverName: string;
  context: SessionContext;
  client: Client | null;
  connecting: Promise<Client> | null;
  /** Connections made for this run so far. */
  opened: number;
  firstOpenedAt: number | null;
  commands: number;
  /** Commands running now, and the ones that wait for their turn. */
  running: number;
  waiting: (() => void)[];
  /** How many may run at a time: fewer than at first, once the machine turned one down. */
  limit: number;
  closing: boolean;
}

interface Store {
  sessions: Map<string, Session>;
}

const holder = globalThis as typeof globalThis & { __xnSsh?: Store };

function store(): Store {
  holder.__xnSsh ??= { sessions: new Map() };
  return holder.__xnSsh;
}

function sessionFor(runId: string, server: Server, context: SessionContext): Session {
  const key = `${runId}:${server.id}`;
  let session = store().sessions.get(key);
  if (!session) {
    session = {
      runId,
      serverId: server.id,
      serverName: server.name,
      context,
      client: null,
      connecting: null,
      opened: 0,
      firstOpenedAt: null,
      commands: 0,
      running: 0,
      waiting: [],
      limit: CHANNELS_AT_ONCE,
      closing: false,
    };
    store().sessions.set(key, session);
  }
  return session;
}

function note(session: Session, command: string, status: "ok" | "lost" | "refused", output?: string): void {
  logCommand({
    server: { id: session.serverId, name: session.serverName },
    kind: "session",
    projectId: session.context.projectId,
    projectTitle: session.context.projectTitle,
    runId: session.runId,
    userId: session.context.userId,
    command,
    status,
    output: output ?? null,
  });
}

function commandsSoFar(session: Session): string {
  return `${session.commands} command${session.commands === 1 ? "" : "s"}`;
}

/** The open connection of a run to a machine: the one there is, or a new one. */
function liveClient(session: Session, server: Server): Promise<Client> {
  if (session.client) return Promise.resolve(session.client);
  if (!session.connecting) {
    session.connecting = (async () => {
      const again = session.opened > 0;
      let problem: SshProblem | null = null;
      for (let attempt = 0; attempt <= RECONNECT_WAITS_MS.length; attempt++) {
        if (attempt > 0) await sleep(RECONNECT_WAITS_MS[attempt - 1]!);
        if (session.closing) throw new SshProblem("off", "The run has ended.", "The run has ended.");
        try {
          const client = await connect(await checkedTarget(server));
          if (session.closing) {
            client.end();
            throw new SshProblem("off", "The run has ended.", "The run has ended.");
          }
          session.client = client;
          session.opened++;
          session.firstOpenedAt ??= Date.now();
          client.on("close", () => {
            if (session.client !== client) return;
            session.client = null;
            if (session.closing) return;
            note(
              session,
              "Connection lost",
              "lost",
              `After ${took(Date.now() - (session.firstOpenedAt ?? Date.now()))} and ${commandsSoFar(session)}. The next command connects again.`,
            );
          });
          noteConnection(server.id, null);
          note(
            session,
            again ? "Connected again" : "Connected",
            "ok",
            `Signed in as ${server.username}. Host key ${fingerprint(server.hostKey) ?? ""}. ` +
              (again ? `Connection number ${session.opened} of this run.` : "It stays open until the run has ended."),
          );
          return client;
        } catch (err) {
          problem = problemOf(err, server.name);
          // Trying again helps against a network that was away for a moment, and against nothing else.
          if (problem.kind !== "unreachable") break;
        }
      }
      const failed = problem ?? new SshProblem("unreachable", "The connection could not be made.", `"${server.name}" could not be reached just now.`);
      if (failed.kind !== "off") {
        noteConnection(server.id, failed.message);
        note(session, "Could not connect", "refused", failed.message);
      }
      throw failed;
    })().finally(() => {
      session.connecting = null;
    });
  }
  return session.connecting;
}

function acquire(session: Session): Promise<void> {
  if (session.running < session.limit) {
    session.running++;
    return Promise.resolve();
  }
  return new Promise((resolve) => session.waiting.push(resolve));
}

function release(session: Session): void {
  session.running = Math.max(0, session.running - 1);
  while (session.running < session.limit && session.waiting.length > 0) {
    session.running++;
    session.waiting.shift()!();
  }
}

export interface RunOnServer {
  runId: string;
  serverId: string;
  context: SessionContext & { taskId: string | null; taskTitle: string | null; agentName: string | null };
  command: string;
  timeoutSeconds: number;
  isCancelled?: () => boolean;
  onProgress?: (elapsedMs: number) => void;
  /**
   * Keys the person handed over (src/lib/access): `fill` puts their values
   * in where the command names them, for the machine alone; `hide` takes
   * them out of what the machine printed. What is written down and what the
   * agent reads holds the names, never a value.
   */
  keys?: { fill(text: string): string; hide(text: string): string };
}

/**
 * Run a command on a machine for a run, over the run's connection to it. The
 * command and how it ended are written down, also when it could not be
 * started. Throws an SshProblem when there is no connection to run it on.
 */
export async function runOnServer(opts: RunOnServer): Promise<{ server: string; result: CommandResult }> {
  // The row as it is now: a machine that an owner has just switched off is not worked on.
  const server = getServer(opts.serverId);
  if (!server) throw new SshProblem("off", "The server is not registered any more.", "That server is not registered any more.");
  const entry = {
    server: { id: server.id, name: server.name },
    kind: "command" as const,
    projectId: opts.context.projectId,
    projectTitle: opts.context.projectTitle,
    runId: opts.runId,
    taskId: opts.context.taskId,
    taskTitle: opts.context.taskTitle,
    agentName: opts.context.agentName,
    userId: opts.context.userId,
    command: opts.command,
  };
  const refuse = (problem: SshProblem): never => {
    logCommand({ ...entry, status: "refused", output: problem.message });
    throw problem;
  };
  if (server.status !== "enabled") {
    return refuse(new SshProblem("off", "The server is switched off.", `"${server.name}" was switched off by an owner. Trying again does not help.`));
  }

  const session = sessionFor(opts.runId, server, opts.context);
  await acquire(session);
  try {
    let result: CommandResult | null = null;
    for (let tries = 0; result === null; tries++) {
      let client: Client;
      try {
        client = await liveClient(session, server);
      } catch (err) {
        return refuse(problemOf(err, server.name));
      }
      try {
        result = await execOn(client, {
          line: remoteCommand(opts.keys ? opts.keys.fill(opts.command) : opts.command),
          timeoutMs: opts.timeoutSeconds * 1000,
          isCancelled: opts.isCancelled,
          onProgress: opts.onProgress,
        });
        if (opts.keys) result = { ...result, stdout: opts.keys.hide(result.stdout), stderr: opts.keys.hide(result.stderr) };
      } catch (err) {
        if (!(err instanceof NotStarted)) throw err;
        if (tries >= 2) {
          return refuse(
            new SshProblem(
              "busy",
              `The machine opened no session for the command: ${sanitizeUpstreamError(err.message, 160)}.`,
              `"${server.name}" did not start the command: it takes no further session just now. A later call tries again.`,
            ),
          );
        }
        if (/not connected/i.test(err.message)) {
          // The connection is gone, and nobody said so: the next round makes a new one.
          if (session.client === client) session.client = null;
          try {
            client.end();
          } catch {
            // Closed already.
          }
        } else if (session.client === client && session.running > 1) {
          // The machine has as many sessions open as it allows, and that is
          // fewer than were asked of it. From now on no more are asked than
          // run at this moment, and this command waits for its turn; waiting
          // is not a failed try.
          session.limit = Math.max(1, session.running - 1);
          release(session);
          await acquire(session);
          tries--;
        } else if (session.client === client) {
          // Nothing else of this run is running there: give the machine a moment.
          await sleep(1_500);
        }
      }
    }
    session.commands++;
    logCommand({
      ...entry,
      status: result.outcome,
      exitCode: result.exitCode,
      signal: result.signal,
      output: logOutput(result),
      outputBytes: Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
      durationMs: result.durationMs,
    });
    return { server: server.name, result };
  } finally {
    release(session);
  }
}

/** Close the connections of a run. Called when the run has ended, however it ended. */
export function closeRun(runId: string, why = "the run has ended"): void {
  const sessions = store().sessions;
  for (const [key, session] of sessions) {
    if (session.runId !== runId) continue;
    sessions.delete(key);
    session.closing = true;
    const client = session.client;
    session.client = null;
    if (client) {
      try {
        client.end();
      } catch {
        // Closed already.
      }
    }
    if (session.opened > 0) {
      note(
        session,
        "Closed",
        "ok",
        `${why[0]!.toUpperCase()}${why.slice(1)}. Open for ${took(Date.now() - (session.firstOpenedAt ?? Date.now()))}, ${commandsSoFar(session)}` +
          (session.opened > 1 ? `, connected ${session.opened} times.` : "."),
      );
    }
  }
}

/** Close every connection: the server process is stopping. */
export function closeAllSessions(why = "the app is stopping"): void {
  for (const runId of new Set([...store().sessions.values()].map((s) => s.runId))) closeRun(runId, why);
}

/** Close what belongs to no run that is executed here any more. Nothing should; this makes sure. */
export function closeStraySessions(activeRunIds: ReadonlySet<string>): void {
  for (const runId of new Set([...store().sessions.values()].map((s) => s.runId))) {
    if (!activeRunIds.has(runId)) closeRun(runId, "its run is not executed any more");
  }
}

export interface OpenSession {
  serverId: string;
  projectId: string | null;
  projectTitle: string | null;
  /** When the run first connected. */
  since: number | null;
  commands: number;
  /** Whether there is a connection at this moment (false between a loss and the next command). */
  connected: boolean;
}

/** The connections runs hold now, for the Servers page. */
export function openSessions(): OpenSession[] {
  return [...store().sessions.values()].map((s) => ({
    serverId: s.serverId,
    projectId: s.context.projectId,
    projectTitle: s.context.projectTitle,
    since: s.firstOpenedAt,
    commands: s.commands,
    connected: s.client !== null,
  }));
}

// ─── An owner's check ────────────────────────────────────────────────────────

/** The one command of a check: what the machine is, and who was signed in. It changes nothing. */
export const CHECK_COMMAND = "uname -sr 2>/dev/null; id -un";

/**
 * Sign in to a machine once, run one harmless command, and sign out: proof
 * that what is registered works. Throws an SshProblem when it does not.
 */
export async function checkServer(target: Target): Promise<{ output: string; durationMs: number }> {
  const started = Date.now();
  const client = await connect(target);
  try {
    const result = await execOn(client, { line: remoteCommand(CHECK_COMMAND), timeoutMs: 20_000 });
    // What counts is that the line was run by sh, which says so itself: that
    // is how every command of an agent is run, timed and ended. A machine
    // that signs in to something else (the command line of a router, a menu,
    // a forced command) would give agents answers that mean nothing.
    if (!result.shell || (result.outcome !== "ok" && result.outcome !== "failed")) {
      const how =
        result.outcome === "timeout"
          ? "it was not over after 20 s"
          : result.outcome === "lost"
            ? "the connection was lost"
            : result.exitCode === null
              ? "no exit code"
              : `exit code ${result.exitCode}`;
      const said = sanitizeUpstreamError(cleanOutput(`${result.stderr}\n${result.stdout}`).replace(/\s+/g, " ").trim(), 200);
      throw new SshProblem(
        "shell",
        `The machine signed us in, but it did not run the command of the check the way a machine with sh does (${how}). ` +
          `It said: ${said || "nothing"}. Agents run their commands with sh: a machine without it cannot be worked on.`,
        "",
      );
    }
    return { output: result.stdout.trim().slice(0, 300), durationMs: Date.now() - started };
  } catch (err) {
    throw err instanceof NotStarted
      ? new SshProblem("busy", `The machine signed us in, and then opened no session for a command: ${sanitizeUpstreamError(err.message, 160)}.`, "")
      : err;
  } finally {
    try {
      client.end();
    } catch {
      // Closed already.
    }
  }
}
