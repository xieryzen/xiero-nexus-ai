import "server-only";
import { and, asc, count, desc, eq, inArray, lt, ne } from "drizzle-orm";
import { db } from "@/db";
import {
  agents,
  browserActions,
  projectSiteAccounts,
  siteAccounts,
  teamAgents,
  users,
  type BrowserAction,
  type Project,
  type SiteAccount,
  type User,
} from "@/db/schema";
import { parseToolNames } from "../agent/catalog";
import { AppError, Errors } from "../errors";
import { decryptSecret, encryptSecret } from "../secrets";
import {
  ACCOUNTS_PER_PROJECT,
  BROWSER_TOOL,
  LOG_KEEP,
  accountName,
  cookieOfSite,
  mayUseAccount,
  siteHost,
  siteUrlProblem,
  type AccountAccess,
  type EarlierAction,
} from "./rules";

/**
 * The accounts on web sites that agents may sign in with: what an owner
 * saved, which projects name which, who may use them, the session a sign-in
 * left, and the log of what was done in the browser. The browser itself is
 * in sessions.ts.
 */

// ─── What is shown of an account ─────────────────────────────────────────────

export interface SiteAccountDTO {
  id: string;
  name: string;
  siteUrl: string;
  /** The site: the host of the address, with everything under it. */
  site: string;
  username: string;
  access: AccountAccess;
  status: "enabled" | "disabled";
  notes: string | null;
  /** Whether a session of an earlier sign-in is kept, and since when. */
  hasSession: boolean;
  sessionSavedAt: number | null;
  sessionCookies: number;
  lastUsedAt: number | null;
  lastProblem: string | null;
  /** Projects that name it. */
  projects: number;
  createdAt: number;
}

/** An account as it is handed out: never with its password or its session. */
export function serializeAccount(row: SiteAccount): SiteAccountDTO {
  const named = db.select({ n: count() }).from(projectSiteAccounts).where(eq(projectSiteAccounts.accountId, row.id)).get();
  return {
    id: row.id,
    name: row.name,
    siteUrl: row.siteUrl,
    site: siteHost(row.siteUrl),
    username: row.username,
    access: row.access,
    status: row.status,
    notes: row.notes,
    hasSession: Boolean(row.sessionCiphertext),
    sessionSavedAt: row.sessionSavedAt ? row.sessionSavedAt.getTime() : null,
    sessionCookies: row.sessionCookies,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.getTime() : null,
    lastProblem: row.lastProblem,
    projects: named?.n ?? 0,
    createdAt: row.createdAt.getTime(),
  };
}

export function getAccount(id: string): SiteAccount | undefined {
  return db.select().from(siteAccounts).where(eq(siteAccounts.id, id)).get();
}

/** The accounts the projects of this user may sign in with. */
export function accountsFor(user: Pick<User, "role">): SiteAccount[] {
  return db
    .select()
    .from(siteAccounts)
    .orderBy(asc(siteAccounts.name))
    .all()
    .filter((row) => mayUseAccount(user.role, row.access));
}

/** The password of an account, for the page it is typed into. */
export function passwordOf(account: SiteAccount): string {
  return decryptSecret(account.secretCiphertext);
}

// ─── Saving and changing ─────────────────────────────────────────────────────

export interface AccountInput {
  name?: string;
  siteUrl?: string;
  username?: string;
  password?: string;
  access?: AccountAccess;
  status?: "enabled" | "disabled";
  notes?: string | null;
}

export interface CheckedAccount {
  values: {
    name: string;
    siteUrl: string;
    username: string;
    secretCiphertext: string;
    access: AccountAccess;
    status: "enabled" | "disabled";
    notes: string | null;
  };
  /** Whether what signs in, or where, differs from what was saved: the kept session is of the old sign-in then. */
  signInChanged: boolean;
}

/** What a request asks to save, checked. Throws a 400 that says what is wrong. */
export function checkedAccount(input: AccountInput, existing?: SiteAccount): CheckedAccount {
  let name = existing?.name ?? "";
  if (input.name !== undefined || !existing) {
    name = accountName(input.name ?? "");
    if (!name) {
      throw Errors.badRequest('A name is lower-case letters, digits, ".", "_" and "-", and starts with a letter or a digit: shop-admin.');
    }
    const taken = db
      .select({ id: siteAccounts.id })
      .from(siteAccounts)
      .where(existing ? and(eq(siteAccounts.name, name), ne(siteAccounts.id, existing.id)) : eq(siteAccounts.name, name))
      .get();
    if (taken) throw Errors.conflict(`There is an account "${name}" already.`);
  }

  const siteUrl = (input.siteUrl ?? existing?.siteUrl ?? "").trim();
  const wrong = siteUrlProblem(siteUrl);
  if (wrong) throw Errors.badRequest(wrong);

  const username = (input.username ?? existing?.username ?? "").trim();
  if (!username) throw Errors.badRequest("Enter the user name (or the e-mail address) the account signs in with.");
  if (username.length > 200) throw Errors.badRequest("The user name is too long (at most 200 characters).");

  let secretCiphertext = existing?.secretCiphertext ?? "";
  if (input.password !== undefined) {
    if (!input.password) throw Errors.badRequest("Enter the password of the account.");
    if (input.password.length > 500) throw Errors.badRequest("The password is too long (at most 500 characters).");
    secretCiphertext = encryptSecret(input.password);
  }
  if (!secretCiphertext) throw Errors.badRequest("Enter the password of the account.");

  const signInChanged =
    Boolean(existing) &&
    (siteHost(siteUrl) !== siteHost(existing!.siteUrl) || username !== existing!.username || input.password !== undefined);

  return {
    values: {
      name,
      siteUrl,
      username,
      secretCiphertext,
      access: input.access ?? existing?.access ?? "owners",
      status: input.status ?? existing?.status ?? "enabled",
      notes: input.notes === undefined ? (existing?.notes ?? null) : input.notes?.trim() || null,
    },
    signInChanged,
  };
}

// ─── The session a sign-in left ──────────────────────────────────────────────

/** A cookie as the browser gives it and takes it back. Only what is needed to put it back. */
export interface SavedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

const COOKIES_MAX = 300;
const SESSION_MAX_BYTES = 400_000;

/** Of what a browser holds, what is part of the sign-in of this account's site. */
export function cookiesOfAccount(all: readonly Record<string, unknown>[], account: Pick<SiteAccount, "siteUrl">): SavedCookie[] {
  const out: SavedCookie[] = [];
  for (const raw of all) {
    const name = typeof raw.name === "string" ? raw.name : "";
    const domain = typeof raw.domain === "string" ? raw.domain : "";
    if (!name || !domain || typeof raw.value !== "string") continue;
    if (!cookieOfSite({ name, domain }, account.siteUrl)) continue;
    const cookie: SavedCookie = { name, value: raw.value, domain, path: typeof raw.path === "string" ? raw.path : "/" };
    // A cookie without an end lasts as long as the browser is open: it is kept too, as a browser that is left open keeps it.
    if (typeof raw.expires === "number" && raw.expires > 0) cookie.expires = raw.expires;
    if (raw.httpOnly === true) cookie.httpOnly = true;
    if (raw.secure === true) cookie.secure = true;
    if (typeof raw.sameSite === "string" && /^(Strict|Lax|None)$/.test(raw.sameSite)) cookie.sameSite = raw.sameSite;
    out.push(cookie);
    if (out.length >= COOKIES_MAX) break;
  }
  return out;
}

/** The session that is kept for an account: the cookies to put back. Empty when none is kept, or when it cannot be read. */
export function sessionOf(account: Pick<SiteAccount, "sessionCiphertext">): SavedCookie[] {
  if (!account.sessionCiphertext) return [];
  try {
    const value = JSON.parse(decryptSecret(account.sessionCiphertext)) as unknown;
    if (!Array.isArray(value)) return [];
    const now = Date.now() / 1000;
    return (value as SavedCookie[]).filter((c) => c && typeof c.name === "string" && typeof c.domain === "string" && (!c.expires || c.expires > now));
  } catch {
    return [];
  }
}

/** Keep the session of an account as a browser holds it now. With no cookie of its site left, nothing is kept. */
export function saveSession(accountId: string, cookies: readonly SavedCookie[]): number {
  const text = JSON.stringify(cookies);
  if (cookies.length === 0 || Buffer.byteLength(text) > SESSION_MAX_BYTES) {
    forgetSession(accountId);
    return 0;
  }
  db.update(siteAccounts)
    .set({ sessionCiphertext: encryptSecret(text), sessionSavedAt: new Date(), sessionCookies: cookies.length })
    .where(eq(siteAccounts.id, accountId))
    .run();
  return cookies.length;
}

export function forgetSession(accountId: string): void {
  db.update(siteAccounts).set({ sessionCiphertext: null, sessionSavedAt: null, sessionCookies: 0 }).where(eq(siteAccounts.id, accountId)).run();
}

/** Note that an account was used, and what stood in the way when something did. */
export function noteUse(accountId: string, problem: string | null): void {
  try {
    db.update(siteAccounts).set({ lastUsedAt: new Date(), lastProblem: problem }).where(eq(siteAccounts.id, accountId)).run();
  } catch {
    // The account was removed in the meantime.
  }
}

// ─── Projects ────────────────────────────────────────────────────────────────

/** The accounts a project names, in the order of their names. */
export function accountsOfProject(projectId: string): SiteAccount[] {
  const ids = db
    .select({ id: projectSiteAccounts.accountId })
    .from(projectSiteAccounts)
    .where(eq(projectSiteAccounts.projectId, projectId))
    .all()
    .map((row) => row.id);
  if (ids.length === 0) return [];
  return db.select().from(siteAccounts).where(inArray(siteAccounts.id, ids)).orderBy(asc(siteAccounts.name)).all();
}

/** The same for many projects at once: project id → names. */
export function accountNamesByProject(projectIds: readonly string[]): Map<string, { id: string; name: string }[]> {
  const out = new Map<string, { id: string; name: string }[]>();
  if (projectIds.length === 0) return out;
  const rows = db
    .select({ projectId: projectSiteAccounts.projectId, id: siteAccounts.id, name: siteAccounts.name })
    .from(projectSiteAccounts)
    .innerJoin(siteAccounts, eq(siteAccounts.id, projectSiteAccounts.accountId))
    .where(inArray(projectSiteAccounts.projectId, [...projectIds]))
    .orderBy(asc(siteAccounts.name))
    .all();
  for (const row of rows) {
    const list = out.get(row.projectId) ?? [];
    list.push({ id: row.id, name: row.name });
    out.set(row.projectId, list);
  }
  return out;
}

/**
 * The accounts a request names for a project, checked: each one exists and
 * may be used by the projects of this user. The answer is the same for an
 * account that does not exist and for one the user may not use, so that it
 * does not say which accounts there are.
 */
export function checkedAccountIds(user: Pick<User, "role">, asked: readonly string[] | null | undefined): string[] {
  const ids = [...new Set(asked ?? [])];
  if (ids.length === 0) return [];
  if (ids.length > ACCOUNTS_PER_PROJECT) {
    throw Errors.badRequest(`A project can name ${ACCOUNTS_PER_PROJECT} site accounts at most.`);
  }
  const usable = new Set(accountsFor(user).map((account) => account.id));
  if (!ids.every((id) => usable.has(id))) {
    throw Errors.badRequest("A site account of this project does not exist, or the projects of this account may not sign in with it.");
  }
  return ids;
}

/** Give a project these accounts, in place of the ones it had. */
export function setProjectAccounts(projectId: string, accountIds: readonly string[]): void {
  db.transaction((tx) => {
    tx.delete(projectSiteAccounts).where(eq(projectSiteAccounts.projectId, projectId)).run();
    for (const accountId of new Set(accountIds)) tx.insert(projectSiteAccounts).values({ projectId, accountId }).run();
  });
}

/**
 * The agents that work for a project and have the tool to work in a
 * browser, by name: of the project's team, or of all agents when it has no
 * team.
 */
export function browsersOf(project: Pick<Project, "teamId">): string[] {
  const columns = { name: agents.name, tools: agents.tools, status: agents.status };
  const rows = project.teamId
    ? db.select(columns).from(agents).innerJoin(teamAgents, eq(teamAgents.agentId, agents.id)).where(eq(teamAgents.teamId, project.teamId)).all()
    : db.select(columns).from(agents).all();
  return rows
    .filter((a) => a.status === "active" && parseToolNames(a.tools).includes(BROWSER_TOOL))
    .map((a) => a.name)
    .sort((a, b) => a.localeCompare(b));
}

export function roleOfUser(userId: string | null): string | null {
  if (!userId) return null;
  return db.select({ role: users.role }).from(users).where(eq(users.id, userId)).get()?.role ?? null;
}

export interface RunAccounts {
  /** The accounts the run may sign in with. */
  accounts: SiteAccount[];
  /** Why the run cannot start, when an account the project names cannot be used. */
  problem: string | null;
}

/**
 * The accounts a run of this project may sign in with. The project's
 * account has to be one whose projects may use each of them now, whatever
 * it was when the project was made; and each has to be switched on.
 */
export function accountsForRun(project: Pick<Project, "id" | "createdBy">): RunAccounts {
  const named = accountsOfProject(project.id);
  if (named.length === 0) return { accounts: [], problem: null };
  const role = roleOfUser(project.createdBy);
  const denied = named.filter((account) => !mayUseAccount(role, account.access));
  if (denied.length > 0) {
    return {
      accounts: [],
      problem: `This project names the site account ${denied.map((a) => `"${a.name}"`).join(", ")}, which the projects of its account may not sign in with.`,
    };
  }
  const off = named.filter((account) => account.status !== "enabled");
  if (off.length > 0) {
    return {
      accounts: [],
      problem: `The site account ${off.map((a) => `"${a.name}"`).join(", ")} of this project is switched off (Browser page).`,
    };
  }
  return { accounts: named, problem: null };
}

/**
 * Whoever tells the agents of a project what to do can have anything done
 * with the accounts the project names. So a project is run, changed,
 * scheduled and approved only by an account whose own projects may sign in
 * with every one of them.
 */
export function assertMayOperateAccounts(project: Pick<Project, "id">, user: Pick<User, "role">): void {
  const denied = accountsOfProject(project.id).filter((account) => !mayUseAccount(user.role, account.access));
  if (denied.length > 0) {
    throw new AppError(
      403,
      "forbidden",
      `This project signs in with the site account ${denied.map((a) => `"${a.name}"`).join(", ")}, which only an owner may use. An owner has to do this.`,
    );
  }
}

// ─── The log ─────────────────────────────────────────────────────────────────

export interface ActionLogEntry {
  kind: string;
  account?: Pick<SiteAccount, "id" | "name"> | null;
  projectId?: string | null;
  projectTitle?: string | null;
  runId?: string | null;
  taskId?: string | null;
  taskTitle?: string | null;
  agentName?: string | null;
  userId?: string | null;
  url?: string | null;
  detail?: string | null;
  status: BrowserAction["status"];
  note?: string | null;
  durationMs?: number | null;
}

let written = 0;

/** Write down what was done in the browser. Never throws: the work goes on whether or not it could be written. */
export function logAction(entry: ActionLogEntry): void {
  try {
    db.insert(browserActions)
      .values({
        kind: entry.kind,
        accountId: entry.account?.id ?? null,
        accountName: entry.account?.name ?? null,
        projectId: entry.projectId ?? null,
        projectTitle: entry.projectTitle ?? null,
        runId: entry.runId ?? null,
        taskId: entry.taskId ?? null,
        taskTitle: entry.taskTitle ?? null,
        agentName: entry.agentName ?? null,
        userId: entry.userId ?? null,
        url: entry.url ? entry.url.slice(0, 500) : null,
        detail: entry.detail ? entry.detail.slice(0, 500) : null,
        status: entry.status,
        note: entry.note ? entry.note.slice(0, 1000) : null,
        durationMs: entry.durationMs ?? null,
      })
      .run();
    written++;
    if (written % 200 === 0) pruneLog();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[xiero-nexus] the browser log could not be written:", err);
  }
}

function pruneLog(): void {
  const edge = db.select({ at: browserActions.createdAt }).from(browserActions).orderBy(desc(browserActions.createdAt)).limit(1).offset(LOG_KEEP).get();
  if (!edge) return;
  db.delete(browserActions).where(lt(browserActions.createdAt, edge.at)).run();
}

export interface ActionDTO {
  id: string;
  kind: string;
  accountId: string | null;
  accountName: string | null;
  projectId: string | null;
  projectTitle: string | null;
  taskTitle: string | null;
  agentName: string | null;
  /** The account of the app the work was done for. */
  username: string | null;
  url: string | null;
  detail: string | null;
  status: BrowserAction["status"];
  note: string | null;
  durationMs: number | null;
  createdAt: number;
}

export interface ActionFilter {
  /** Only what was done for the projects of this user of the app. */
  userId?: string;
  limit?: number;
  before?: number;
}

/** The log, newest first. */
export function listActions(filter: ActionFilter = {}): ActionDTO[] {
  const conditions = [];
  if (filter.userId) conditions.push(eq(browserActions.userId, filter.userId));
  if (filter.before) conditions.push(lt(browserActions.createdAt, new Date(filter.before)));
  const rows = db
    .select({ row: browserActions, username: users.username })
    .from(browserActions)
    .leftJoin(users, eq(users.id, browserActions.userId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(browserActions.createdAt))
    .limit(Math.min(200, Math.max(1, filter.limit ?? 60)))
    .all();
  return rows.map(({ row, username }) => ({
    id: row.id,
    kind: row.kind,
    accountId: row.accountId,
    accountName: row.accountName,
    projectId: row.projectId,
    projectTitle: row.projectTitle,
    taskTitle: row.taskTitle,
    agentName: row.agentName,
    username: username ?? null,
    url: row.url,
    detail: row.detail,
    status: row.status,
    note: row.note,
    durationMs: row.durationMs,
    createdAt: row.createdAt.getTime(),
  }));
}

/** What a task did in the browser so far that changed something, oldest first: for an attempt that starts over. */
export function actionsOfTask(taskId: string): EarlierAction[] {
  return db
    .select({ kind: browserActions.kind, detail: browserActions.detail, url: browserActions.url, status: browserActions.status })
    .from(browserActions)
    .where(and(eq(browserActions.taskId, taskId), ne(browserActions.kind, "open")))
    .orderBy(asc(browserActions.createdAt))
    .limit(200)
    .all()
    .map((row) => ({ kind: row.kind, detail: row.detail ?? "", url: row.url ?? "", outcome: row.status }));
}
