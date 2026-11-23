import "server-only";
import { and, asc, count, desc, eq, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  agents,
  projectServers,
  projects,
  serverCommands,
  servers,
  teamAgents,
  users,
  type Project,
  type Server,
  type ServerCommand,
  type User,
} from "@/db/schema";
import { parseToolNames } from "../agent/catalog";
import { AppError, Errors } from "../errors";
import { decryptSecret } from "../secrets";
import { fingerprint, hostKeyFile, parseHostKey } from "./host-key";
import { LOG_KEEP, SERVERS_PER_PROJECT, SERVER_TOOL, mayUseServer, type EarlierCommand } from "./rules";

/**
 * The machines agents may work on over SSH: what is registered, which
 * projects name which, who may use them, and the log of what was done there.
 * The connections themselves are in sessions.ts.
 */

// ─── What is shown of a machine ──────────────────────────────────────────────

export interface ServerDTO {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "key";
  /** The type of the host key that was accepted, and what `ssh-keygen -lf` prints for it. */
  hostKeyType: string;
  fingerprint: string;
  /** The file on the machine that holds that key. */
  hostKeyFile: string;
  access: "owners" | "admins";
  status: "enabled" | "disabled";
  notes: string | null;
  lastConnectedAt: number | null;
  lastError: string | null;
  /** How many projects name it. */
  projects: number;
  createdAt: number;
  updatedAt: number;
}

/** A machine without what signs in to it: the password and the private key never leave the server. */
export function serializeServer(row: Server): ServerDTO {
  const key = parseHostKey(row.hostKey);
  const named = db.select({ n: count() }).from(projectServers).where(eq(projectServers.serverId, row.id)).get();
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    authType: row.authType,
    hostKeyType: key?.type ?? "",
    fingerprint: fingerprint(row.hostKey) ?? "",
    hostKeyFile: hostKeyFile(key?.type ?? ""),
    access: row.access,
    status: row.status,
    notes: row.notes,
    lastConnectedAt: row.lastConnectedAt?.getTime() ?? null,
    lastError: row.lastError,
    projects: named?.n ?? 0,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

export function getServer(id: string): Server | undefined {
  return db.select().from(servers).where(eq(servers.id, id)).get();
}

/**
 * A machine an owner registered on the Servers page, for the routes that
 * manage those. One an account handed over in a conversation is that
 * account's to manage (Memory page), and is not found here.
 */
export function registeredServer(id: string): Server | undefined {
  const row = getServer(id);
  return row && row.ownerId === null ? row : undefined;
}

/**
 * The machines an owner registered that the projects of this account may
 * work on, by name. A machine an account handed over in a conversation
 * (`ownerId`, src/lib/access) is not among them: no project names it, and
 * only that account's chats and runs work on it.
 */
export function serversFor(user: Pick<User, "role">): Server[] {
  return db
    .select()
    .from(servers)
    .orderBy(asc(servers.name))
    .all()
    .filter((server) => server.ownerId === null && mayUseServer(user.role, server.access));
}

/** What signs in to a machine, decrypted. Used for a connection and nothing else. */
export function credentialsOf(server: Server): { password?: string; privateKey?: string; passphrase?: string } {
  const secret = decryptSecret(server.secretCiphertext);
  if (server.authType === "password") return { password: secret };
  return {
    privateKey: secret,
    passphrase: server.passphraseCiphertext ? decryptSecret(server.passphraseCiphertext) : undefined,
  };
}

// ─── The machines of a project ───────────────────────────────────────────────

/** The machines a project names, by name. */
export function serversOfProject(projectId: string): Server[] {
  const ids = db
    .select({ id: projectServers.serverId })
    .from(projectServers)
    .where(eq(projectServers.projectId, projectId))
    .all()
    .map((row) => row.id);
  if (ids.length === 0) return [];
  return db.select().from(servers).where(inArray(servers.id, ids)).orderBy(asc(servers.name)).all();
}

/** The same for many projects at once: project id → names. */
export function serverNamesByProject(projectIds: readonly string[]): Map<string, { id: string; name: string }[]> {
  const out = new Map<string, { id: string; name: string }[]>();
  if (projectIds.length === 0) return out;
  const rows = db
    .select({ projectId: projectServers.projectId, id: servers.id, name: servers.name })
    .from(projectServers)
    .innerJoin(servers, eq(servers.id, projectServers.serverId))
    .where(inArray(projectServers.projectId, [...projectIds]))
    .orderBy(asc(servers.name))
    .all();
  for (const row of rows) {
    const list = out.get(row.projectId) ?? [];
    list.push({ id: row.id, name: row.name });
    out.set(row.projectId, list);
  }
  return out;
}

/**
 * The machines a request names for a project, checked: each one exists and
 * may be used by the projects of this account. The answer is the same for a
 * machine that does not exist and for one the account may not use, so that
 * it does not say which machines there are.
 */
export function checkedServerIds(user: Pick<User, "role">, asked: readonly string[] | null | undefined): string[] {
  const ids = [...new Set(asked ?? [])];
  if (ids.length === 0) return [];
  if (ids.length > SERVERS_PER_PROJECT) {
    throw Errors.badRequest(`A project can name ${SERVERS_PER_PROJECT} servers at most.`);
  }
  const usable = new Set(serversFor(user).map((server) => server.id));
  if (!ids.every((id) => usable.has(id))) {
    throw Errors.badRequest("A server of this project does not exist, or the projects of this account may not work on it.");
  }
  return ids;
}

/** Give a project these machines, in place of the ones it had. */
export function setProjectServers(projectId: string, serverIds: readonly string[]): void {
  db.transaction((tx) => {
    tx.delete(projectServers).where(eq(projectServers.projectId, projectId)).run();
    for (const serverId of new Set(serverIds)) tx.insert(projectServers).values({ projectId, serverId }).run();
  });
}

/**
 * The agents that work for a project and have the tool to work on servers,
 * by name: of the project's team, or of all agents when it has no team. A
 * project that names a server and has none of them reaches nothing.
 */
export function operatorsOf(project: Pick<Project, "teamId">): string[] {
  const columns = { name: agents.name, tools: agents.tools, status: agents.status };
  const rows = project.teamId
    ? db.select(columns).from(agents).innerJoin(teamAgents, eq(teamAgents.agentId, agents.id)).where(eq(teamAgents.teamId, project.teamId)).all()
    : db.select(columns).from(agents).all();
  return rows
    .filter((a) => a.status === "active" && parseToolNames(a.tools).includes(SERVER_TOOL))
    .map((a) => a.name)
    .sort((a, b) => a.localeCompare(b));
}

function roleOf(userId: string | null): string | null {
  if (!userId) return null;
  return db.select({ role: users.role }).from(users).where(eq(users.id, userId)).get()?.role ?? null;
}

export interface RunServers {
  /** The machines the run works on. */
  servers: Server[];
  /** Why the run cannot start, when a machine the project names cannot be used. */
  problem: string | null;
}

/**
 * The machines a run of this project works on. The project's account has to
 * be one whose projects may use each of them now, whatever it was when the
 * project was made; and each has to be switched on.
 */
export function serversForRun(project: Pick<Project, "id" | "createdBy">): RunServers {
  const named = serversOfProject(project.id);
  if (named.length === 0) return { servers: [], problem: null };
  const role = roleOf(project.createdBy);
  const denied = named.filter((server) => !mayUseServer(role, server.access));
  if (denied.length > 0) {
    return {
      servers: [],
      problem: `This project names the server ${denied.map((s) => `"${s.name}"`).join(", ")}, which the projects of its account may not work on.`,
    };
  }
  const off = named.filter((server) => server.status !== "enabled");
  if (off.length > 0) {
    return {
      servers: [],
      problem: `The server ${off.map((s) => `"${s.name}"`).join(", ")} of this project is switched off (Servers page).`,
    };
  }
  return { servers: named, problem: null };
}

/**
 * Whoever tells the agents of a project what to do can have anything done on
 * the machines the project names. So a project is run, changed, scheduled
 * and approved only by an account whose own projects may use every one of
 * them. Anyone else who may open the project can still read it.
 */
export function assertMayOperate(project: Pick<Project, "id">, user: Pick<User, "role">): void {
  const denied = serversOfProject(project.id).filter((server) => !mayUseServer(user.role, server.access));
  if (denied.length > 0) {
    throw new AppError(
      403,
      "forbidden",
      `This project works on the server ${denied.map((s) => `"${s.name}"`).join(", ")}, which only an owner may use. An owner has to do this.`,
    );
  }
}

// ─── The log ─────────────────────────────────────────────────────────────────

export interface CommandLogEntry {
  server: Pick<Server, "id" | "name">;
  kind: "command" | "session" | "test";
  projectId?: string | null;
  projectTitle?: string | null;
  runId?: string | null;
  taskId?: string | null;
  taskTitle?: string | null;
  agentName?: string | null;
  userId?: string | null;
  command: string;
  status: ServerCommand["status"];
  exitCode?: number | null;
  signal?: string | null;
  output?: string | null;
  outputBytes?: number;
  durationMs?: number | null;
}

const written = new Map<string, number>();

/** Write down what was done on a machine. Never throws: the work goes on whether or not it could be written. */
export function logCommand(entry: CommandLogEntry): void {
  try {
    db.insert(serverCommands)
      .values({
        serverId: entry.server.id,
        serverName: entry.server.name,
        kind: entry.kind,
        projectId: entry.projectId ?? null,
        projectTitle: entry.projectTitle ?? null,
        runId: entry.runId ?? null,
        taskId: entry.taskId ?? null,
        taskTitle: entry.taskTitle ?? null,
        agentName: entry.agentName ?? null,
        userId: entry.userId ?? null,
        command: entry.command,
        status: entry.status,
        exitCode: entry.exitCode ?? null,
        signal: entry.signal ?? null,
        output: entry.output ?? null,
        outputBytes: entry.outputBytes ?? 0,
        durationMs: entry.durationMs ?? null,
      })
      .run();
    // Now and then, what is beyond the number kept for this machine makes way.
    const n = (written.get(entry.server.id) ?? 0) + 1;
    written.set(entry.server.id, n);
    if (n % 200 === 0) pruneLog(entry.server.id);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[xiero-nexus] the server log could not be written:", err);
  }
}

function pruneLog(serverId: string): void {
  const edge = db
    .select({ at: serverCommands.createdAt })
    .from(serverCommands)
    .where(eq(serverCommands.serverId, serverId))
    .orderBy(desc(serverCommands.createdAt))
    .limit(1)
    .offset(LOG_KEEP)
    .get();
  if (!edge) return;
  db.delete(serverCommands)
    .where(and(eq(serverCommands.serverId, serverId), lt(serverCommands.createdAt, edge.at)))
    .run();
}

export interface CommandDTO {
  id: string;
  serverId: string | null;
  serverName: string;
  kind: "command" | "session" | "test";
  projectId: string | null;
  projectTitle: string | null;
  taskTitle: string | null;
  agentName: string | null;
  /** The account the work was done for. */
  username: string | null;
  command: string;
  status: ServerCommand["status"];
  exitCode: number | null;
  signal: string | null;
  output: string | null;
  outputBytes: number;
  durationMs: number | null;
  createdAt: number;
}

export interface LogFilter {
  /** One machine; "removed" for the machines that are not registered any more; none for all. */
  serverId?: string | "removed";
  /** Only the machines with these ids (and none that was removed). */
  among?: readonly string[];
  /** Rows at or before this moment, for the next page. */
  before?: number;
  limit?: number;
}

/** The log, newest first. */
export function listCommands(filter: LogFilter = {}): CommandDTO[] {
  const limit = Math.min(200, Math.max(1, filter.limit ?? 50));
  const where = [];
  if (filter.serverId === "removed") where.push(isNull(serverCommands.serverId));
  else if (filter.serverId) where.push(eq(serverCommands.serverId, filter.serverId));
  if (filter.among) {
    if (filter.among.length === 0) return [];
    where.push(inArray(serverCommands.serverId, [...filter.among]));
  }
  // At or before: rows of the same millisecond as the last one shown come again, and the page leaves out what it has.
  if (filter.before) where.push(lte(serverCommands.createdAt, new Date(filter.before)));
  const rows = db
    .select({ row: serverCommands, username: users.username, title: projects.title })
    .from(serverCommands)
    .leftJoin(users, eq(users.id, serverCommands.userId))
    .leftJoin(projects, eq(projects.id, serverCommands.projectId))
    .where(where.length > 0 ? and(...where) : undefined)
    // Rows of the same millisecond keep the order they were written in.
    .orderBy(desc(serverCommands.createdAt), desc(sql`${serverCommands}.rowid`))
    .limit(limit)
    .all();
  return rows.map(({ row, username, title }) => ({
    id: row.id,
    serverId: row.serverId,
    serverName: row.serverName,
    kind: row.kind,
    projectId: row.projectId,
    projectTitle: title ?? row.projectTitle,
    taskTitle: row.taskTitle,
    agentName: row.agentName,
    username: username ?? null,
    command: row.command,
    status: row.status,
    exitCode: row.exitCode,
    signal: row.signal,
    output: row.output,
    outputBytes: row.outputBytes,
    durationMs: row.durationMs,
    createdAt: row.createdAt.getTime(),
  }));
}

/** The commands a task has run so far, oldest first: what an attempt that starts over is told. */
export function commandsOfTask(taskId: string): EarlierCommand[] {
  return db
    .select({
      server: serverCommands.serverName,
      command: serverCommands.command,
      status: serverCommands.status,
      exitCode: serverCommands.exitCode,
    })
    .from(serverCommands)
    .where(and(eq(serverCommands.taskId, taskId), eq(serverCommands.kind, "command")))
    .orderBy(asc(serverCommands.createdAt), asc(sql`${serverCommands}.rowid`))
    .all();
}

/** Note on a machine's row that a connection was made, or why one could not be. */
export function noteConnection(serverId: string, problem: string | null): void {
  try {
    db.update(servers)
      .set(problem === null ? { lastConnectedAt: new Date(), lastError: null } : { lastError: problem })
      .where(eq(servers.id, serverId))
      .run();
  } catch {
    // The row is gone, or the database cannot be written: the connection is what counts.
  }
}
