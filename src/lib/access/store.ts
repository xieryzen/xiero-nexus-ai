import "server-only";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { accessKeys, servers, siteAccounts, users, type AccessKey, type Server, type SiteAccount, type User } from "@/db/schema";
import { audit } from "../audit";
import { accountsFor, forgetSession } from "../browser/accounts";
import { accountName, pairOfOneSite, siteHost, siteUrlProblem } from "../browser/rules";
import { AppError } from "../errors";
import { rateLimit, rateLimitFull } from "../ratelimit";
import { decryptSecret, encryptSecret, last4 } from "../secrets";
import { fingerprint, normalizeHostKey } from "../ssh/host-key";
import { hostProblem, portOf, serverName, usernameProblem } from "../ssh/rules";
import { serversFor } from "../ssh/servers";
import { SshProblem, checkServer, readHostKey, type Target } from "../ssh/sessions";
import { assertWebAddress } from "../web-fetch";
import { publicAddressOf } from "./address";
import { findAccess, replaceSpans, type FoundItem, type FoundKey, type FoundServer, type FoundSite } from "./find";
import {
  FAILED_KEEPS_MAX,
  FAILED_KEEPS_WINDOW_MS,
  HANDED_AT_ONCE,
  KEEPS_PER_MINUTE,
  OWN_KEYS_MAX,
  OWN_SERVERS_MAX,
  OWN_SITES_MAX,
  accountNameFor,
  freeName,
  keyNameFor,
  markFor,
  mayHandOver,
  ownAccessMode,
  serverNameFor,
  siteOfKey,
  type Kept,
  type OwnAccessMode,
} from "./rules";

/**
 * Keeping what an account hands over in a conversation, and giving it back
 * to that account's chats and runs. A server is tried before it is kept: the
 * app signs in once and runs one harmless command. The host key the machine
 * showed then is the one it has to show from then on.
 */

type Who = Pick<User, "id" | "role">;

export function accessMode(): OwnAccessMode {
  return ownAccessMode(process.env.OWN_ACCESS);
}

/** Whether this account may hand access over in a conversation. */
export function handsOver(user: Pick<User, "role">): boolean {
  return mayHandOver(user.role, accessMode());
}

const NOT_ON = "Handing access over in a conversation is not switched on for this account on this installation, so nothing was kept.";

// ─── What an account has handed over ─────────────────────────────────────────

function roleOf(userId: string): string | null {
  return db.select({ role: users.role }).from(users).where(eq(users.id, userId)).get()?.role ?? null;
}

/** Whether the account may work with what it handed over, as things are now. */
function mayWork(userId: string | null | undefined): userId is string {
  if (!userId) return false;
  return mayHandOver(roleOf(userId), accessMode());
}

/** The machines an account handed over, the ones worked on last first. `all` includes the ones that are switched off. */
export function ownServers(userId: string | null | undefined, all = false): Server[] {
  if (!userId || (!all && !mayWork(userId))) return [];
  return db
    .select()
    .from(servers)
    .where(eq(servers.ownerId, userId))
    .orderBy(desc(servers.lastConnectedAt), desc(servers.createdAt))
    .all()
    .filter((row) => all || row.status === "enabled");
}

/** The sign-ins to sites an account handed over. Of two on one site, the one that was used last. */
export function ownAccounts(userId: string | null | undefined, all = false): SiteAccount[] {
  if (!userId || (!all && !mayWork(userId))) return [];
  const rows = db
    .select()
    .from(siteAccounts)
    .where(eq(siteAccounts.ownerId, userId))
    .orderBy(desc(siteAccounts.lastUsedAt), desc(siteAccounts.createdAt))
    .all();
  if (all) return rows;
  const usable: SiteAccount[] = [];
  for (const row of rows) {
    if (row.status !== "enabled") continue;
    // One browser is signed in to a site as one account at a time.
    if (pairOfOneSite([...usable, row])) continue;
    usable.push(row);
  }
  return usable;
}

export function ownKeys(userId: string | null | undefined, all = false): AccessKey[] {
  if (!userId || (!all && !mayWork(userId))) return [];
  return db
    .select()
    .from(accessKeys)
    .where(eq(accessKeys.ownerId, userId))
    .orderBy(desc(accessKeys.lastUsedAt), desc(accessKeys.createdAt))
    .all()
    .filter((row) => all || row.status === "enabled");
}

/** The values of keys, by name: for the one place where the app puts them in. */
export function keyValues(keys: readonly AccessKey[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const key of keys) {
    try {
      values.set(key.name, decryptSecret(key.secretCiphertext));
    } catch {
      // A key that cannot be read is one the AI does not have.
    }
  }
  return values;
}

export function noteKeyUse(ids: readonly string[]): void {
  for (const id of ids) {
    try {
      db.update(accessKeys).set({ lastUsedAt: new Date() }).where(eq(accessKeys.id, id)).run();
    } catch {
      // Removed in the meantime.
    }
  }
}

/** Whether any account other than this one has handed something over that is in use: for what the pages say. */
export function hasOwnAccess(userId: string | null | undefined): boolean {
  if (!userId) return false;
  return ownServers(userId).length + ownAccounts(userId).length + ownKeys(userId).length > 0;
}

// ─── Keeping ─────────────────────────────────────────────────────────────────

function limited(user: Who): string | null {
  const rate = rateLimit(`access:${user.id}`, KEEPS_PER_MINUTE, 60_000);
  return rate.ok ? null : "Too many sign-ins were tried for this account in a minute. Nothing was kept; send it again in a minute.";
}

/** Too many sign-ins of this account failed: nothing more is tried for a while. */
function failedTooOften(user: Who): string | null {
  const full = rateLimitFull(`access-failed:${user.id}`, FAILED_KEEPS_MAX);
  if (full.ok) return null;
  const minutes = Math.max(1, Math.ceil(full.retryAfterMs / 60_000));
  return `Too many sign-ins failed for this account, so the app tries no more for ${minutes} ${minutes === 1 ? "minute" : "minutes"}. Nothing was kept. Check the address, the user name and the password, and send them again then.`;
}

/** A sign-in that was tried and failed: counted, and written down for an owner, without what was tried. */
function failed(user: Who, item: FoundServer, port: number, why: string, opts: KeepOptions): void {
  rateLimit(`access-failed:${user.id}`, FAILED_KEEPS_MAX, FAILED_KEEPS_WINDOW_MS);
  audit({
    actorUserId: user.id,
    action: "access.server_refused",
    targetType: "server",
    targetId: `${item.username}@${item.host}:${port}`.slice(0, 200),
    metadata: { host: item.host, port, username: item.username, why: why.slice(0, 200), how: "conversation" },
    ip: opts.ip,
    userAgent: opts.userAgent,
  });
}

/**
 * The names that are taken for an account: of what it handed over itself,
 * and of what an owner opened to its role, since its conversations work with
 * both. What other accounts handed over has names of its own: two accounts
 * can each have a "vps-1-2-3-4", and neither learns of the other's.
 */
function takenNames(user: Who, table: "servers" | "sites"): Set<string> {
  if (table === "servers") {
    const own = db.select({ name: servers.name }).from(servers).where(eq(servers.ownerId, user.id)).all();
    return new Set([...own, ...serversFor(user)].map((r) => r.name));
  }
  const own = db.select({ name: siteAccounts.name }).from(siteAccounts).where(eq(siteAccounts.ownerId, user.id)).all();
  return new Set([...own, ...accountsFor(user)].map((r) => r.name));
}

export interface KeepOptions {
  /** The name to keep it under, when the person or the assistant gave one. */
  name?: string;
  /** What it is for, in a few words: the AI is told. */
  notes?: string;
  ip?: string;
  userAgent?: string;
}

/** Try a server and keep it. Never throws: what went wrong is in the answer. */
export async function keepServer(user: Who, item: FoundServer, opts: KeepOptions = {}): Promise<Kept> {
  const port = portOf(item.port) ?? 22;
  const where = `${item.username}@${item.host}${port === 22 ? "" : `:${port}`}`;
  const no = (note: string): Kept => ({ kind: "server", name: "", where, ok: false, updated: false, note });
  if (!handsOver(user)) return no(NOT_ON);
  const wrong = hostProblem(item.host) ?? usernameProblem(item.username);
  if (wrong) return no(wrong);
  const secret = item.privateKey ?? item.password ?? "";
  if (!secret) return no("There was no password and no private key with it.");
  const tooMany = failedTooOften(user) ?? limited(user);
  if (tooMany) return no(tooMany);

  const host = item.host.trim();
  // Anyone but an owner hands over machines on the public internet only.
  let connectTo = host;
  if (user.role !== "owner") {
    try {
      connectTo = await publicAddressOf(host);
    } catch (err) {
      return no(err instanceof AppError ? err.message : "The address could not be checked.");
    }
  }

  const mine = db.select().from(servers).where(eq(servers.ownerId, user.id)).all();
  const existing = mine.find((row) => row.host.toLowerCase() === host.toLowerCase() && row.port === port && row.username === item.username);
  if (!existing && mine.length >= OWN_SERVERS_MAX) {
    return no(`This account has ${OWN_SERVERS_MAX} servers kept already. Remove one on the Memory page first.`);
  }

  let output: string;
  let hostKey: string;
  try {
    // The key the machine showed the first time is the one it has to show now.
    hostKey = existing ? existing.hostKey : (normalizeHostKey(await readHostKey(connectTo, port)) ?? "");
    if (!hostKey) return no("The machine showed a host key of a kind this app does not know.");
    const target: Target = {
      name: existing?.name ?? host,
      host: connectTo,
      port,
      username: item.username,
      hostKey,
      ...(item.privateKey ? { privateKey: item.privateKey, passphrase: item.passphrase } : { password: item.password }),
    };
    output = (await checkServer(target)).output;
  } catch (err) {
    if (err instanceof SshProblem) {
      failed(user, item, port, err.kind, opts);
      return no(
        `The app could not sign in to ${where}: ${err.message}` +
          (existing && err.kind === "host_key" ? " It is not the key this machine showed when it was first handed over; remove the server on the Memory page if the machine was set up anew." : ""),
      );
    }
    failed(user, item, port, "error", opts);
    return no(`The app could not sign in to ${where}.`);
  }

  const system = output.split("\n")[0]?.trim() ?? "";
  const values = {
    host,
    port,
    username: item.username,
    authType: item.privateKey ? ("key" as const) : ("password" as const),
    secretCiphertext: encryptSecret(secret),
    passphraseCiphertext: item.privateKey && item.passphrase ? encryptSecret(item.passphrase) : null,
    hostKey,
    status: "enabled" as const,
    lastConnectedAt: new Date(),
    lastError: null,
    updatedAt: new Date(),
  };
  const notes = (opts.notes?.replace(/\s+/g, " ").trim() || system || "").slice(0, 400) || null;
  let name: string;
  if (existing) {
    name = existing.name;
    db.update(servers).set({ ...values, notes: opts.notes ? notes : existing.notes ?? notes }).where(eq(servers.id, existing.id)).run();
  } else {
    const wanted = opts.name ? serverName(opts.name) : null;
    name = freeName(wanted ?? serverNameFor(host), takenNames(user, "servers"));
    db.insert(servers)
      .values({ ...values, name, access: "owners", notes, createdBy: user.id, ownerId: user.id })
      .run();
  }
  audit({
    actorUserId: user.id,
    action: existing ? "access.server_changed" : "access.server_kept",
    targetType: "server",
    targetId: existing?.id ?? name,
    metadata: { name, host, port, username: item.username, signIn: values.authType, hostKey: fingerprint(hostKey), how: "conversation" },
    ip: opts.ip,
    userAgent: opts.userAgent,
  });
  return {
    kind: "server",
    name,
    where,
    ok: true,
    updated: Boolean(existing),
    note: `The app signed in and ran one harmless command${system ? `: the machine runs ${system}` : ""}. Host key ${fingerprint(hostKey) ?? ""}.`,
  };
}

/** Keep how to sign in to a site. It is tried when it is first used, in the browser. */
export async function keepSite(user: Who, item: FoundSite, opts: KeepOptions = {}): Promise<Kept> {
  const url = item.url.trim();
  const host = siteHost(url);
  const where = `${item.username} at ${host || url}`;
  const no = (note: string): Kept => ({ kind: "site", name: "", where, ok: false, updated: false, note });
  if (!handsOver(user)) return no(NOT_ON);
  const wrong = siteUrlProblem(url);
  if (wrong) return no(wrong);
  if (!item.username.trim() || item.username.length > 200) return no("There was no user name to sign in with.");
  if (!item.password || item.password.length > 500) return no("There was no password with it.");
  if (user.role !== "owner") {
    try {
      await assertWebAddress(url);
    } catch (err) {
      return no(err instanceof AppError ? `${err.message}.` : "The address could not be checked.");
    }
  }
  const mine = db.select().from(siteAccounts).where(eq(siteAccounts.ownerId, user.id)).all();
  const existing = mine.find((row) => siteHost(row.siteUrl) === host && row.username === item.username.trim());
  if (!existing && mine.length >= OWN_SITES_MAX) {
    return no(`This account has ${OWN_SITES_MAX} site accounts kept already. Remove one on the Memory page first.`);
  }
  const notes = opts.notes?.replace(/\s+/g, " ").trim().slice(0, 400) || null;
  let name: string;
  if (existing) {
    name = existing.name;
    db.update(siteAccounts)
      .set({ siteUrl: url, secretCiphertext: encryptSecret(item.password), status: "enabled", ...(notes ? { notes } : {}), updatedAt: new Date() })
      .where(eq(siteAccounts.id, existing.id))
      .run();
    // What the old password left in the browser is not the new sign-in's.
    forgetSession(existing.id);
  } else {
    const wanted = opts.name ? accountName(opts.name) : "";
    name = freeName(wanted || accountNameFor(url), takenNames(user, "sites"));
    db.insert(siteAccounts)
      .values({ name, siteUrl: url, username: item.username.trim(), secretCiphertext: encryptSecret(item.password), access: "owners", notes, createdBy: user.id, ownerId: user.id })
      .run();
  }
  audit({
    actorUserId: user.id,
    action: existing ? "access.site_changed" : "access.site_kept",
    targetType: "site_account",
    targetId: existing?.id ?? name,
    metadata: { name, site: host, username: item.username.trim(), how: "conversation" },
    ip: opts.ip,
    userAgent: opts.userAgent,
  });
  return {
    kind: "site",
    name,
    where,
    ok: true,
    updated: Boolean(existing),
    note: "It is tried when it is first used: the app types the password on the site's own sign-in page, in the browser.",
  };
}

/** Keep a key. */
export function keepKey(user: Who, item: FoundKey, opts: KeepOptions = {}): Kept {
  const label = (item.label.replace(/\s+/g, " ").trim() || "API key").slice(0, 80);
  const no = (note: string): Kept => ({ kind: "key", name: "", where: label, ok: false, updated: false, note });
  if (!handsOver(user)) return no(NOT_ON);
  if (!item.value || item.value.length > 4000) return no("There was no value with it.");
  const site = siteOfKey(item.site) || null;
  const mine = db.select().from(accessKeys).where(eq(accessKeys.ownerId, user.id)).all();
  const wanted = keyNameFor(opts.name || label);
  // The same thing handed over again replaces its value: by its name, or by
  // the value itself. A key of that name for another site is another key.
  const existing = mine.find((row) => row.name === wanted && (!site || !row.site || row.site === site)) ?? mine.find((row) => safeValue(row) === item.value);
  if (!existing && mine.length >= OWN_KEYS_MAX) return no(`This account has ${OWN_KEYS_MAX} keys kept already. Remove one on the Memory page first.`);
  let name: string;
  if (existing) {
    name = existing.name;
    db.update(accessKeys)
      .set({ secretCiphertext: encryptSecret(item.value), hint: last4(item.value), status: "enabled", ...(site ? { site } : {}), updatedAt: new Date() })
      .where(eq(accessKeys.id, existing.id))
      .run();
  } else {
    name = freeName(wanted, new Set(mine.map((row) => row.name)));
    db.insert(accessKeys)
      .values({ ownerId: user.id, name, label, site, secretCiphertext: encryptSecret(item.value), hint: last4(item.value) })
      .run();
  }
  audit({
    actorUserId: user.id,
    action: existing ? "access.key_changed" : "access.key_kept",
    targetType: "access_key",
    targetId: existing?.id ?? name,
    metadata: { name, label, site, how: "conversation" },
    ip: opts.ip,
    userAgent: opts.userAgent,
  });
  const tied = site ?? existing?.site ?? null;
  return {
    kind: "key",
    name,
    where: label,
    ok: true,
    updated: Boolean(existing),
    note: tied
      ? `Write {{key:${name}}} where its value belongs. In a web request the app sends it only to ${tied}.`
      : `Write {{key:${name}}} where its value belongs in a command on a server. It is tied to no site, so it is sent in no web request until the person says which site it is for.`,
  };
}

function safeValue(row: AccessKey): string | null {
  try {
    return decryptSecret(row.secretCiphertext);
  } catch {
    return null;
  }
}

export function keep(user: Who, item: FoundItem, opts: KeepOptions = {}): Promise<Kept> {
  if (item.kind === "server") return keepServer(user, item, opts);
  if (item.kind === "site") return keepSite(user, item, opts);
  return Promise.resolve(keepKey(user, item, opts));
}

export interface Taken {
  /** The text without what signs in. */
  text: string;
  kept: Kept[];
  /** What was taken out, so that it can be taken out of other texts as well. */
  secrets: string[];
}

/**
 * Take what signs in out of a text a person wrote, and keep it. The text
 * that comes back is what is stored and what a model is shown. A secret is
 * taken out whether or not it could be kept: a password that was refused is
 * a password all the same.
 */
export async function takeAccessFrom(user: Who, text: string, opts: KeepOptions = {}): Promise<Taken> {
  const found = findAccess(text);
  if (found.length === 0) return { text, kept: [], secrets: [] };
  const kept: Kept[] = [];
  const parts: { start: number; end: number; with: string }[] = [];
  const secrets: string[] = [];
  for (const one of found) {
    const result = await keep(user, one.item, opts);
    kept.push(result);
    for (const secret of one.secrets) {
      parts.push({ start: secret.start, end: secret.end, with: markFor(secret.what, result) });
      secrets.push(text.slice(secret.start, secret.end));
    }
  }
  return { text: replaceSpans(text, parts), kept, secrets };
}

/**
 * The same for what is written for a project: its goal, the instruction of
 * a run or of a schedule. What signs in is kept for the account that wrote
 * it. A run works with the access of the account the project belongs to: so
 * where somebody else wrote it, the note says that the run does not have it.
 */
export async function takeAccessForProject(
  user: Who,
  project: { createdBy: string | null } | null,
  text: string | null | undefined,
  opts: KeepOptions = {},
): Promise<Taken> {
  if (!text) return { text: text ?? "", kept: [], secrets: [] };
  const taken = await takeAccessFrom(user, text, opts);
  if (project && project.createdBy !== user.id) {
    for (const kept of taken.kept) {
      if (kept.ok) kept.note += " It is kept for your account: this project belongs to another account, whose runs work with that account's own access and not with yours.";
    }
  }
  return taken;
}

/** A text without secrets the app has taken out elsewhere: for what the assistant writes down itself. */
export function withoutSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length < 4) continue;
    out = out.split(secret).join("[kept by the app]");
  }
  return out;
}

// ─── What a person sees and changes (Memory page) ────────────────────────────

export interface AccessDTO {
  kind: "server" | "site" | "key";
  id: string;
  name: string;
  where: string;
  detail: string | null;
  status: "enabled" | "disabled";
  problem: string | null;
  lastUsedAt: number | null;
  createdAt: number;
}

export function accessOf(userId: string): AccessDTO[] {
  return [
    ...ownServers(userId, true).map((s): AccessDTO => ({
      kind: "server",
      id: s.id,
      name: s.name,
      where: `${s.username}@${s.host}${s.port === 22 ? "" : `:${s.port}`}`,
      detail: [s.notes, fingerprint(s.hostKey) ? `host key ${fingerprint(s.hostKey)}` : ""].filter(Boolean).join(" · ") || null,
      status: s.status,
      problem: s.lastError,
      lastUsedAt: s.lastConnectedAt?.getTime() ?? null,
      createdAt: s.createdAt.getTime(),
    })),
    ...ownAccounts(userId, true).map((a): AccessDTO => ({
      kind: "site",
      id: a.id,
      name: a.name,
      where: `${a.username} at ${siteHost(a.siteUrl) || a.siteUrl}`,
      detail: a.notes,
      status: a.status,
      problem: a.lastProblem,
      lastUsedAt: a.lastUsedAt?.getTime() ?? null,
      createdAt: a.createdAt.getTime(),
    })),
    ...ownKeys(userId, true).map((k): AccessDTO => ({
      kind: "key",
      id: k.id,
      name: k.name,
      where: k.label,
      detail: [k.site ? `sent only to ${k.site}` : "tied to no site", k.hint ? `ends in ${k.hint}` : ""].filter(Boolean).join(" · "),
      status: k.status,
      problem: null,
      lastUsedAt: k.lastUsedAt?.getTime() ?? null,
      createdAt: k.createdAt.getTime(),
    })),
  ];
}

/** Switch something an account handed over on or off, tie a key to a site, or remove it. Only its own. */
export function changeAccess(
  user: Who,
  kind: AccessDTO["kind"],
  id: string,
  change: { status?: "enabled" | "disabled"; site?: string | null; remove?: boolean },
  meta: { ip?: string; userAgent?: string } = {},
): boolean {
  const table = kind === "server" ? servers : kind === "site" ? siteAccounts : accessKeys;
  const row = db
    .select({ id: table.id, name: table.name })
    .from(table)
    .where(and(eq(table.id, id), eq(table.ownerId, user.id), isNotNull(table.ownerId)))
    .get();
  if (!row) return false;
  if (change.remove) {
    db.delete(table).where(eq(table.id, id)).run();
  } else {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (change.status) set.status = change.status;
    if (kind === "key" && change.site !== undefined) set.site = siteOfKey(change.site) || null;
    db.update(table).set(set).where(eq(table.id, id)).run();
  }
  audit({
    actorUserId: user.id,
    action: change.remove ? `access.${kind}_removed` : `access.${kind}_changed`,
    targetType: kind === "server" ? "server" : kind === "site" ? "site_account" : "access_key",
    targetId: id,
    metadata: { name: row.name, ...(change.status ? { status: change.status } : {}), ...(change.site !== undefined ? { site: siteOfKey(change.site) || null } : {}) },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return true;
}

export { HANDED_AT_ONCE };
