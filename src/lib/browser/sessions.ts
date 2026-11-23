import "server-only";
import { randomUUID } from "node:crypto";
import type { SiteAccount } from "@/db/schema";
import { notify } from "../notifications";
import { cookiesOfAccount, keepSessionOf, logAction, noteUse, passwordOf, sessionOf, type SavedCookie } from "./accounts";
import { CdpError, type CdpConnection } from "./cdp";
import { BrowserPage, PageProblem } from "./page";
import {
  OWNER_SESSION_MINUTES,
  PAGES_PER_TASK,
  VIEWPORT,
  hostOfSite,
  maxPages,
  personKey,
  shownUrl,
  siteHost,
  took,
  waitMinutes,
} from "./rules";
import { BrowserProblem, closeConnection, connection, onBrowserConnect } from "./service";
import { signIn, type SignInOutcome } from "./signin";

/**
 * The pages agents have open, and the pages a person has taken over.
 *
 * A run gets a browser of its own inside the browser service: a context
 * with its own cookies, in which every task of the run has its own tab.
 * What a task signs in to, the next task of the run finds signed in. When
 * the run has ended, the context is closed; the cookies of the sites the
 * project's accounts belong to are kept with those accounts, for the next
 * run.
 *
 * Where a site asks for a person, the page is handed over: it stays open,
 * the person is told, sees it in the app and acts on it there, and hands it
 * back. Nothing here solves or gets around what a site checks.
 *
 * Kept on `globalThis`, like the rest of what is one per server process:
 * the worker that executes runs and the request handlers both look here.
 */

/** What is known of the run a page belongs to. */
export interface RunSpec {
  runId: string;
  /** Null for a conversation, which has no project. */
  projectId: string | null;
  projectTitle: string;
  /** The account of the app the project belongs to. */
  userId: string | null;
  /** The site accounts the run may sign in with. */
  accounts: SiteAccount[];
}

export interface TaskSpec {
  taskId: string;
  taskTitle: string;
  agentName: string | null;
}

interface TaskPages {
  taskId: string;
  pages: BrowserPage[];
  /** The page as it was last read, for reading on in it. */
  text: string;
  /** What happened to the tabs since the agent was last told. */
  notes: string[];
  handovers: number;
  actedAt: number;
}

export interface RunBrowser {
  runId: string;
  conn: CdpConnection;
  contextId: string;
  spec: RunSpec;
  accounts: Map<string, { row: SiteAccount; touched: boolean }>;
  /** The passwords of the run's accounts: never shown to an agent, whatever a page does with them and whoever typed them. */
  secrets: Set<string>;
  tasks: Map<string, TaskPages>;
  closed: boolean;
}

export type LiveOutcome = "continue" | "give_up" | "timeout" | "cancelled" | "closed" | "save" | "discard";

interface Live {
  id: string;
  /** run: a page of a task that waits for a person. owner: a sign-in an owner does by hand. */
  kind: "run" | "owner";
  /** Who may open it, besides an owner: the account of the app the run works for. */
  userId: string | null;
  runId: string | null;
  projectId: string | null;
  projectTitle: string | null;
  taskTitle: string | null;
  agentName: string | null;
  account: { id: string; name: string } | null;
  reason: string;
  site: string;
  since: number;
  deadline: number;
  /** The app itself is acting on the page: a person's hand waits. */
  busy: boolean;
  /** What the app says about the page. */
  note: string | null;
  page: () => BrowserPage | null;
  settle: (outcome: LiveOutcome) => void;
  /** Called when a person touched the page: an owner's sign-in stays open while it is used. */
  touched: () => void;
}

interface Store {
  runs: Map<string, RunBrowser>;
  opening: Map<string, Promise<RunBrowser>>;
  live: Map<string, Live>;
  /** Contexts of sign-ins an owner does by hand: context id → the pages of it. */
  owners: Map<string, { pages: BrowserPage[] }>;
  hooked: WeakSet<CdpConnection>;
  listening: boolean;
  /** Tabs the app itself is opening now, by context: they are not taken for tabs a site opened. */
  creating: Map<string, number>;
}

const g = globalThis as unknown as { __xnBrowser?: Store };

function store(): Store {
  g.__xnBrowser ??= { runs: new Map(), opening: new Map(), live: new Map(), owners: new Map(), hooked: new WeakSet(), listening: false, creating: new Map() };
  return g.__xnBrowser;
}

const BLANK = "about:blank#xn";

function lost(err: unknown): never {
  if (err instanceof BrowserProblem || err instanceof PageProblem) throw err;
  if (err instanceof CdpError) {
    throw new BrowserProblem(err.gone ? "The connection to the browser service was lost." : `The browser did not do it: ${err.message}.`);
  }
  throw err;
}

/** Pages that are open now, of every run and every owner. */
export function openPages(): number {
  const s = store();
  let n = 0;
  for (const run of s.runs.values()) for (const task of run.tasks.values()) n += task.pages.filter((p) => !p.closed).length;
  for (const owner of s.owners.values()) n += owner.pages.filter((p) => !p.closed).length;
  return n;
}

/** A new tab of the app's own, in a context. */
async function ownPage(conn: CdpConnection, contextId: string): Promise<BrowserPage> {
  const s = store();
  s.creating.set(contextId, (s.creating.get(contextId) ?? 0) + 1);
  try {
    return await BrowserPage.open(conn, contextId, BLANK);
  } finally {
    const left = (s.creating.get(contextId) ?? 1) - 1;
    if (left > 0) s.creating.set(contextId, left);
    else s.creating.delete(contextId);
  }
}

// ─── Tabs a site opens by itself ─────────────────────────────────────────────

async function adopt(conn: CdpConnection, info: { targetId?: string; type?: string; url?: string; openerId?: string; browserContextId?: string }): Promise<void> {
  if (info.type !== "page" || !info.targetId || !info.browserContextId) return;
  const s = store();
  // The app's own new tabs: they start at an address no site opens, and the app knows that it is opening one.
  if (info.url === BLANK) return;
  if (!info.openerId && (s.creating.get(info.browserContextId) ?? 0) > 0) return;
  const run = [...s.runs.values()].find((r) => r.conn === conn && r.contextId === info.browserContextId);
  const owner = s.owners.get(info.browserContextId);
  if (!run && !owner) return;
  if (run && [...run.tasks.values()].some((t) => t.pages.some((p) => p.targetId === info.targetId))) return;
  let page: BrowserPage;
  try {
    page = await BrowserPage.adopt(conn, info.targetId);
  } catch {
    return;
  }
  if (owner) {
    owner.pages.push(page);
    return;
  }
  if (!run || run.closed) {
    void page.close();
    return;
  }
  const tasks = [...run.tasks.values()];
  const task =
    tasks.find((t) => t.pages.some((p) => p.targetId === info.openerId)) ??
    tasks.filter((t) => t.pages.some((p) => !p.closed)).sort((a, b) => b.actedAt - a.actedAt)[0];
  if (!task) {
    void page.close();
    return;
  }
  if (task.pages.filter((p) => !p.closed).length >= PAGES_PER_TASK) {
    task.notes.push(`The site tried to open another tab, but ${PAGES_PER_TASK} are open already: it was closed.`);
    void page.close();
    return;
  }
  task.pages.push(page);
  task.notes.push("The site opened a new tab: it is shown now.");
}

function hook(conn: CdpConnection): void {
  const s = store();
  if (s.hooked.has(conn)) return;
  s.hooked.add(conn);
  conn.on("Target.targetCreated", undefined, (params) => {
    void adopt(conn, (params.targetInfo ?? {}) as Parameters<typeof adopt>[1]);
  });
  conn.onClose(() => {
    // Every page went with the connection.
    for (const [runId, run] of [...s.runs]) {
      if (run.conn !== conn) continue;
      run.closed = true;
      s.runs.delete(runId);
    }
    for (const live of [...s.live.values()]) live.settle("closed");
    s.owners.clear();
  });
}

function listen(): void {
  const s = store();
  if (s.listening) return;
  s.listening = true;
  onBrowserConnect(hook);
}

// ─── The browser of a run ────────────────────────────────────────────────────

async function newContext(conn: CdpConnection, cookies: SavedCookie[]): Promise<string> {
  // It goes when the app's connection goes: nothing is left open by an app that stopped.
  const { browserContextId } = await conn.send<{ browserContextId: string }>("Target.createBrowserContext", { disposeOnDetach: true });
  await conn.send("Browser.setDownloadBehavior", { behavior: "deny", browserContextId }).catch(() => undefined);
  if (cookies.length > 0) {
    try {
      await conn.send("Storage.setCookies", { cookies, browserContextId });
    } catch {
      // One by one: a cookie the browser does not take must not cost the others.
      for (const cookie of cookies) await conn.send("Storage.setCookies", { cookies: [cookie], browserContextId }).catch(() => undefined);
    }
  }
  return browserContextId;
}

/**
 * The password of an account is kept from an agent from the start of the
 * run, whoever types it: the app when it signs in, or a person who takes a
 * page over and signs in by hand.
 */
function keepSecret(secrets: Set<string>, account: SiteAccount): void {
  try {
    secrets.add(passwordOf(account));
  } catch {
    // It cannot be read (another SECRET_ENCRYPTION_KEY): signing in with it says so.
  }
}

/** The browser of a run: the one it has, or a new one with the sessions of its accounts put back. */
export async function runBrowser(spec: RunSpec): Promise<RunBrowser> {
  listen();
  const s = store();
  const existing = s.runs.get(spec.runId);
  if (existing && !existing.closed && !existing.conn.closed) {
    for (const row of spec.accounts) {
      if (existing.accounts.has(row.id)) continue;
      existing.accounts.set(row.id, { row, touched: false });
      keepSecret(existing.secrets, row);
    }
    return existing;
  }
  if (existing) s.runs.delete(spec.runId);
  const pending = s.opening.get(spec.runId);
  if (pending) return pending;
  const opening = (async () => {
    try {
      const conn = await connection();
      hook(conn);
      const cookies = spec.accounts.flatMap((row) => sessionOf(row));
      const contextId = await newContext(conn, cookies);
      const browser: RunBrowser = {
        runId: spec.runId,
        conn,
        contextId,
        spec,
        accounts: new Map(spec.accounts.map((row) => [row.id, { row, touched: false }])),
        secrets: new Set(),
        tasks: new Map(),
        closed: false,
      };
      for (const row of spec.accounts) keepSecret(browser.secrets, row);
      s.runs.set(spec.runId, browser);
      return browser;
    } catch (err) {
      return lost(err);
    } finally {
      s.opening.delete(spec.runId);
    }
  })();
  s.opening.set(spec.runId, opening);
  return opening;
}

/** The tabs of a task, with at least one open. */
export async function taskPages(browser: RunBrowser, taskId: string): Promise<TaskPages> {
  let task = browser.tasks.get(taskId);
  if (!task) {
    task = { taskId, pages: [], text: "", notes: [], handovers: 0, actedAt: Date.now() };
    browser.tasks.set(taskId, task);
  }
  task.pages = task.pages.filter((p) => !p.closed);
  if (task.pages.length === 0) {
    const limit = maxPages(process.env.BROWSER_MAX_PAGES);
    if (openPages() >= limit) {
      throw new BrowserProblem(`The browser has ${limit} pages open, which is as many as it is allowed (BROWSER_MAX_PAGES). Try again when other work has ended.`);
    }
    try {
      task.pages.push(await ownPage(browser.conn, browser.contextId));
    } catch (err) {
      lost(err);
    }
    task.text = "";
  }
  return task;
}

/** The tab of a task that is in front: the newest that is open. Null when none is. */
export function currentPage(task: TaskPages): BrowserPage | null {
  task.pages = task.pages.filter((p) => !p.closed);
  return task.pages[task.pages.length - 1] ?? null;
}

/** Mark the accounts whose site a page is on: their sessions are kept when the run ends. */
export function visited(browser: RunBrowser, url: string): void {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return;
  }
  for (const entry of browser.accounts.values()) {
    if (!entry.touched && hostOfSite(host, entry.row.siteUrl)) entry.touched = true;
  }
}

/** Keep the sessions of the accounts a run used, as its browser holds them now. */
export async function keepSessions(browser: RunBrowser): Promise<void> {
  const used = [...browser.accounts.values()].filter((entry) => entry.touched);
  if (used.length === 0 || browser.conn.closed) return;
  let cookies: Record<string, unknown>[];
  try {
    cookies = (await browser.conn.send<{ cookies: Record<string, unknown>[] }>("Storage.getCookies", { browserContextId: browser.contextId })).cookies;
  } catch {
    return;
  }
  // Every account whose session this browser was given, used or not: a cookie
  // that two of them could call theirs is kept for neither.
  const all = [...browser.accounts.values()].map((entry) => entry.row);
  for (const entry of used) {
    try {
      // Not when the account signs in as someone else by now: this browser holds the old sign-in.
      keepSessionOf(
        entry.row,
        cookiesOfAccount(
          cookies,
          entry.row,
          all.filter((row) => row.id !== entry.row.id),
        ),
      );
    } catch {
      // The account was removed in the meantime.
    }
  }
}

/** Sign in on a task's page with one of the run's accounts. */
export async function signInOn(browser: RunBrowser, page: BrowserPage, account: SiteAccount): Promise<SignInOutcome> {
  const entry = browser.accounts.get(account.id);
  if (entry) entry.touched = true;
  let password: string;
  try {
    password = passwordOf(account);
  } catch {
    noteUse(account.id, "The saved password cannot be read (another SECRET_ENCRYPTION_KEY?).");
    return { state: "error", message: "the saved password cannot be read; an owner has to enter it again (Browser page)" };
  }
  browser.secrets.add(password);
  let outcome: SignInOutcome;
  try {
    outcome = await signIn(page, account, password);
  } catch (err) {
    if (err instanceof PageProblem && err.kind === "secret") noteUse(account.id, err.message);
    return lost(err);
  }
  if (outcome.state === "signed_in" || outcome.state === "no_form") {
    noteUse(account.id, null);
    await keepSessions(browser);
  } else if (outcome.state === "refused") {
    noteUse(account.id, "The site did not take the sign-in: the form was still there after it was sent.");
  } else if (outcome.state === "other_site") {
    noteUse(account.id, `The password is asked for on ${outcome.host}, which is not the site of this account.`);
  } else if (outcome.state === "error") {
    noteUse(account.id, `The page could not be opened: ${outcome.message}.`);
  }
  return outcome;
}

// ─── A page in a person's hands ──────────────────────────────────────────────

export interface HandOver {
  reason: string;
  account?: SiteAccount | null;
  isCancelled?: () => boolean;
  /** Called once the page waits: with where a person opens it. */
  onWaiting?: (link: string) => void;
}

export interface HandOverResult {
  outcome: Exclude<LiveOutcome, "save" | "discard">;
  /** How long the page was in a person's hands, or waited for one. */
  waitedMs: number;
  /** How long it would have waited at most. */
  waitMs: number;
}

export function liveLink(id: string): string {
  return `/dashboard/browser/live/${id}`;
}

/** Hand a task's page to a person and wait until it is handed back, given up, or nobody came. */
export function handOver(browser: RunBrowser, task: TaskPages, spec: TaskSpec, ask: HandOver): Promise<HandOverResult> {
  const s = store();
  const id = randomUUID();
  const since = Date.now();
  const minutes = waitMinutes(process.env.BROWSER_WAIT_MINUTES);
  // For the checks of this app only: seconds instead of minutes.
  const testSeconds = Number(process.env.BROWSER_WAIT_SECONDS);
  const waitMs = Number.isFinite(testSeconds) && testSeconds >= 1 ? testSeconds * 1000 : minutes * 60_000;
  const page = currentPage(task);
  const site = page ? siteHost(page.lastUrl) || "a page" : "a page";
  task.handovers++;

  return new Promise<HandOverResult>((resolve) => {
    let done = false;
    const settle = (outcome: LiveOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(watch);
      s.live.delete(id);
      const waitedMs = Date.now() - since;
      const result = outcome === "save" ? "continue" : outcome === "discard" ? "give_up" : outcome;
      logAction({
        kind: "person",
        account: ask.account ?? null,
        projectId: browser.spec.projectId,
        projectTitle: browser.spec.projectTitle,
        runId: browser.runId,
        taskId: spec.taskId,
        taskTitle: spec.taskTitle,
        agentName: spec.agentName,
        userId: browser.spec.userId,
        url: page ? shownUrl(page.lastUrl) : null,
        detail: ask.reason,
        status: result === "continue" ? "waited" : result === "timeout" ? "timeout" : result === "cancelled" ? "cancelled" : "refused",
        note:
          result === "continue"
            ? `A person took the page over and handed it back after ${took(waitedMs)}.`
            : result === "give_up"
              ? "A person looked at the page and said that it cannot be done."
              : result === "timeout"
                ? `Nobody took the page over within ${took(waitMs)}.`
                : result === "cancelled"
                  ? "The run was stopped while the page waited."
                  : "The page was closed while it waited.",
        durationMs: waitedMs,
      });
      resolve({ outcome: result, waitedMs, waitMs });
    };
    const timer = setTimeout(() => settle("timeout"), waitMs);
    const watch = setInterval(() => {
      if (ask.isCancelled?.()) settle("cancelled");
      else if (browser.closed || !currentPage(task)) settle("closed");
    }, 1_000);
    s.live.set(id, {
      id,
      kind: "run",
      userId: browser.spec.userId,
      runId: browser.runId,
      projectId: browser.spec.projectId,
      projectTitle: browser.spec.projectTitle,
      taskTitle: spec.taskTitle,
      agentName: spec.agentName,
      account: ask.account ? { id: ask.account.id, name: ask.account.name } : null,
      reason: ask.reason,
      site,
      since,
      deadline: since + waitMs,
      busy: false,
      note: null,
      page: () => currentPage(task),
      settle,
      touched: () => undefined,
    });
    notify(browser.spec.userId, {
      kind: "run",
      level: "warning",
      title: `${spec.agentName ?? "An agent"} waits for you in the browser`,
      body: `${spec.taskTitle} (${browser.spec.projectTitle}): ${ask.reason} It waits ${took(waitMs)}.`,
      link: liveLink(id),
    });
    ask.onWaiting?.(liveLink(id));
  });
}

// ─── A sign-in an owner does by hand ─────────────────────────────────────────

function ownerNote(outcome: SignInOutcome): string {
  switch (outcome.state) {
    case "signed_in":
      return "The app filled in the form and sent it, and the form is gone. When the page shows that you are signed in, keep the session.";
    case "no_form":
      return "The site shows no sign-in form: either the session that is kept still holds, or this address is not the page with the form. When the page shows that you are signed in, keep the session.";
    case "needs_person":
      return outcome.filled
        ? `The app filled in the form. The site asks for ${outcome.verification.label}: do that here, send the form, and keep the session when you are in.`
        : `The site asks for ${outcome.verification.label}: do that here, and keep the session when you are in.`;
    case "refused":
      return "The site did not take the sign-in: the form is still there after it was sent. Sign in here by hand, or correct the account.";
    case "other_site":
      return `The password is asked for on ${outcome.host}, which is not the site of this account: the app does not type it there. Sign in here by hand, or save the account with that address.`;
    case "error":
      return `The page could not be opened: ${outcome.message}.`;
  }
}

/**
 * Open the site of an account for an owner, with the form filled in as far
 * as the app can, to be finished by hand: a CAPTCHA, a code. What the owner
 * leaves the page with is kept as the account's session.
 */
export async function ownerSession(account: SiteAccount, user: { id: string }): Promise<{ id: string }> {
  listen();
  const s = store();
  // One at a time for an account.
  for (const live of [...s.live.values()]) {
    if (live.kind === "owner" && live.account?.id === account.id) live.settle("discard");
  }
  const limit = maxPages(process.env.BROWSER_MAX_PAGES);
  if (openPages() >= limit) {
    throw new BrowserProblem(`The browser has ${limit} pages open, which is as many as it is allowed (BROWSER_MAX_PAGES). Try again when other work has ended.`);
  }
  let conn: CdpConnection;
  let contextId: string;
  let first: BrowserPage;
  try {
    conn = await connection();
    hook(conn);
    contextId = await newContext(conn, sessionOf(account));
    first = await ownPage(conn, contextId);
  } catch (err) {
    return lost(err);
  }
  const pages = { pages: [first] };
  s.owners.set(contextId, pages);
  const front = () => {
    pages.pages = pages.pages.filter((p) => !p.closed);
    return pages.pages[pages.pages.length - 1] ?? null;
  };

  const id = randomUUID();
  const since = Date.now();
  const idleMs = OWNER_SESSION_MINUTES * 60_000;
  let done = false;
  let timer = setTimeout(() => live.settle("timeout"), idleMs);
  const live: Live = {
    id,
    kind: "owner",
    userId: user.id,
    runId: null,
    projectId: null,
    projectTitle: null,
    taskTitle: null,
    agentName: null,
    account: { id: account.id, name: account.name },
    reason: `Sign in to ${siteHost(account.siteUrl)} as ${account.username}.`,
    site: siteHost(account.siteUrl),
    since,
    deadline: since + idleMs,
    busy: true,
    note: "The app is opening the site and filling in the form…",
    page: front,
    touched: () => {
      clearTimeout(timer);
      live.deadline = Date.now() + idleMs;
      timer = setTimeout(() => live.settle("timeout"), idleMs);
    },
    settle: (outcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      s.live.delete(id);
      void (async () => {
        let kept = 0;
        // The account was changed while the owner signed in: what was signed in to is not what it is now.
        let changed = false;
        const page = front();
        const url = page ? shownUrl(page.lastUrl) : null;
        if (outcome === "save" && !conn.closed) {
          try {
            const { cookies } = await conn.send<{ cookies: Record<string, unknown>[] }>("Storage.getCookies", { browserContextId: contextId });
            const saved = keepSessionOf(account, cookiesOfAccount(cookies, account));
            changed = saved === null;
            kept = saved ?? 0;
            if (!changed) noteUse(account.id, null);
          } catch {
            kept = 0;
          }
        }
        logAction({
          kind: "session",
          account,
          userId: user.id,
          url,
          detail: `Signed in by hand as ${account.username}`,
          status: outcome === "save" ? (kept > 0 ? "ok" : "failed") : outcome === "timeout" ? "timeout" : "cancelled",
          note:
            outcome === "save"
              ? kept > 0
                ? `The session was kept: ${kept} ${kept === 1 ? "cookie" : "cookies"} of the site.`
                : changed
                  ? "The account was changed while this sign-in went on: what was signed in to is not what the account is now, and nothing was kept."
                  : "The site left no cookie to keep: there is no session to come back to."
              : outcome === "timeout"
                ? `Nothing was done for ${OWNER_SESSION_MINUTES} minutes: the page was closed, and nothing was kept.`
                : "The page was closed, and nothing was kept.",
          durationMs: Date.now() - since,
        });
        s.owners.delete(contextId);
        if (!conn.closed) await conn.send("Target.disposeBrowserContext", { browserContextId: contextId }).catch(() => undefined);
      })();
    },
  };
  s.live.set(id, live);

  // The form is filled in while the owner already sees the page.
  void (async () => {
    try {
      const outcome = await signIn(first, account, passwordOf(account));
      live.note = ownerNote(outcome);
    } catch (err) {
      live.note =
        err instanceof PageProblem && err.kind === "secret"
          ? `${err.message} Type it here yourself, send the form, and keep the session when you are in.`
          : err instanceof PageProblem || err instanceof BrowserProblem
            ? err.message
            : "The app could not fill in the form. Sign in here by hand.";
    } finally {
      live.busy = false;
    }
  })();
  return { id };
}

// ─── What a person sees and does ─────────────────────────────────────────────

export interface LiveDTO {
  id: string;
  kind: "run" | "owner";
  reason: string;
  site: string;
  account: string | null;
  projectId: string | null;
  projectTitle: string | null;
  /** The conversation it is a page of, when it is one of the Chat page's and not of a project's run. */
  chatId: string | null;
  taskTitle: string | null;
  agentName: string | null;
  since: number;
  deadline: number;
  busy: boolean;
  note: string | null;
  /** The size of the window, for where a click lands. */
  width: number;
  height: number;
}

function dto(live: Live): LiveDTO {
  return {
    id: live.id,
    kind: live.kind,
    reason: live.reason,
    site: live.site,
    account: live.account?.name ?? null,
    projectId: live.projectId,
    projectTitle: live.projectTitle,
    // The answers of a conversation work under "chat:<id>" (chat/turn.ts).
    chatId: !live.projectId && live.runId?.startsWith("chat:") ? live.runId.slice(5) : null,
    taskTitle: live.taskTitle,
    agentName: live.agentName,
    since: live.since,
    deadline: live.deadline,
    busy: live.busy,
    note: live.note,
    width: VIEWPORT.width,
    height: VIEWPORT.height,
  };
}

function mayOpen(live: Live, user: { id: string; role: string }): boolean {
  if (user.role === "owner") return true;
  return live.kind === "run" && live.userId !== null && live.userId === user.id;
}

/** The pages that wait for this person: their own runs', and for an owner everyone's. */
export function liveFor(user: { id: string; role: string }): LiveDTO[] {
  return [...store().live.values()]
    .filter((live) => mayOpen(live, user))
    .sort((a, b) => a.since - b.since)
    .map(dto);
}

/** One of them, or null when it does not wait any more or is not this person's to open. */
export function liveOf(id: string, user: { id: string; role: string }): LiveDTO | null {
  const live = store().live.get(id);
  return live && mayOpen(live, user) ? dto(live) : null;
}

function held(id: string, user: { id: string; role: string }): { live: Live; page: BrowserPage } | null {
  const live = store().live.get(id);
  if (!live || !mayOpen(live, user)) return null;
  const page = live.page();
  return page ? { live, page } : null;
}

/**
 * A picture of the page, and where it is. Null when the page does not wait
 * any more; "later" when no picture could be taken at this moment (the page
 * is between two documents): the next one is.
 */
export async function livePicture(id: string, user: { id: string; role: string }): Promise<{ jpeg: Buffer; url: string } | "later" | null> {
  const found = held(id, user);
  if (!found) return null;
  try {
    return { jpeg: await found.page.picture(), url: found.page.lastUrl };
  } catch {
    return found.page.closed ? null : "later";
  }
}

export type LiveInput =
  | { type: "click"; x: number; y: number; double?: boolean }
  | { type: "scroll"; x: number; y: number; dy: number }
  | { type: "key"; key: string; code?: string; shift?: boolean }
  | { type: "text"; text: string }
  | { type: "back" }
  | { type: "reload" };

const clamp = (n: number, max: number) => Math.min(max - 1, Math.max(0, Math.round(n)));

/** Pass on what a person did to the page. False when the page does not wait any more, or the app itself is acting on it. */
export async function liveInput(id: string, user: { id: string; role: string }, input: LiveInput): Promise<"ok" | "gone" | "busy" | "invalid"> {
  const found = held(id, user);
  if (!found) return "gone";
  if (found.live.busy) return "busy";
  const { page, live } = found;
  live.touched();
  try {
    switch (input.type) {
      case "click":
        await page.clickAt(clamp(input.x, VIEWPORT.width), clamp(input.y, VIEWPORT.height), input.double ? 2 : 1);
        return "ok";
      case "scroll":
        await page.wheel(clamp(input.x, VIEWPORT.width), clamp(input.y, VIEWPORT.height), 0, Math.max(-2000, Math.min(2000, Math.round(input.dy))));
        return "ok";
      case "key": {
        const spec = personKey(input);
        if (!spec) return "invalid";
        await page.key(spec, input.shift ? 8 : 0);
        return "ok";
      }
      case "text":
        if (!input.text || input.text.length > 2000) return "invalid";
        await page.insert(input.text);
        return "ok";
      case "back":
        await page.back();
        return "ok";
      case "reload":
        await page.reload();
        return "ok";
      default:
        return "invalid";
    }
  } catch {
    return page.closed ? "gone" : "ok";
  }
}

/** A person says what becomes of the page: handed back, given up; or, for an owner's sign-in, kept or dropped. */
export function liveSettle(id: string, user: { id: string; role: string }, outcome: "continue" | "give_up" | "save" | "discard"): boolean {
  const live = store().live.get(id);
  if (!live || !mayOpen(live, user)) return false;
  if (live.kind === "run" && outcome !== "continue" && outcome !== "give_up") return false;
  if (live.kind === "owner" && outcome !== "save" && outcome !== "discard") return false;
  live.settle(outcome);
  return true;
}

// ─── Closing ─────────────────────────────────────────────────────────────────

/** Close the tabs of a task: it has ended. The run's browser stays for the tasks that follow. */
export function closeTaskPages(runId: string, taskId: string): void {
  const browser = store().runs.get(runId);
  const task = browser?.tasks.get(taskId);
  if (!browser || !task) return;
  browser.tasks.delete(taskId);
  for (const page of task.pages) {
    visited(browser, page.lastUrl);
    void page.close();
  }
}

/** Close the browser of a run: it has ended, however it ended. The sessions of its accounts are kept first. */
export async function closeRunBrowser(runId: string): Promise<void> {
  const s = store();
  const pending = s.opening.get(runId);
  if (pending) await pending.catch(() => undefined);
  const browser = s.runs.get(runId);
  if (!browser) return;
  browser.closed = true;
  s.runs.delete(runId);
  for (const live of [...s.live.values()]) if (live.runId === runId) live.settle("closed");
  for (const task of browser.tasks.values()) for (const page of task.pages) visited(browser, page.lastUrl);
  try {
    await keepSessions(browser);
  } catch {
    // What could not be kept is signed in to again.
  }
  if (!browser.conn.closed) await browser.conn.send("Target.disposeBrowserContext", { browserContextId: browser.contextId }).catch(() => undefined);
}

/** Close what belongs to no run that is executed here any more. Nothing should; this makes sure. */
export function closeStrayBrowsers(activeRunIds: ReadonlySet<string>): void {
  for (const runId of [...store().runs.keys()]) {
    if (!activeRunIds.has(runId)) void closeRunBrowser(runId);
  }
}

/** The app is stopping: keep what can be kept in a moment, and let the browser close the rest. */
export async function closeAllBrowsers(): Promise<void> {
  const s = store();
  for (const live of [...s.live.values()]) live.settle(live.kind === "owner" ? "discard" : "closed");
  const runs = [...s.runs.values()];
  await Promise.race([
    Promise.allSettled(runs.map((browser) => keepSessions(browser))),
    new Promise((resolve) => setTimeout(resolve, 1_500)),
  ]);
  for (const browser of runs) browser.closed = true;
  s.runs.clear();
  closeConnection();
}

/** What is open now, for the Browser page. */
export function browserUse(): { runs: number; pages: number; waiting: number } {
  const s = store();
  return { runs: s.runs.size, pages: openPages(), waiting: s.live.size };
}
