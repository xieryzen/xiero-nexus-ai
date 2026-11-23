import "server-only";
import type { AccessKey, Server, SiteAccount } from "@/db/schema";
import { siteHost } from "../browser/rules";
import { GENERIC, accessForModel, keyMark, relevantTo, relevantToTask, siteOfKey } from "./rules";
import { ownAccounts, ownKeys, ownServers } from "./store";

/**
 * What a run of a project works with, of what the project's account handed
 * over itself in a conversation or in the project's goal. No project names
 * it and nobody set it up: the run is handed what its goal is about, each
 * task what its own text is about, and every agent can work with it,
 * whatever tools are ticked on it.
 */
export interface OwnAccess {
  servers: Server[];
  accounts: SiteAccount[];
  keys: AccessKey[];
}

export const NO_ACCESS: OwnAccess = { servers: [], accounts: [], keys: [] };

const serverNamed = (s: Server) => ({ name: s.name, host: s.host });
const accountNamed = (a: SiteAccount) => ({ name: a.name, host: siteHost(a.siteUrl) });
const keyNamed = (k: AccessKey) => ({ name: k.name, host: siteOfKey(k.site) || null, label: k.label });

function pick<T>(items: readonly T[], named: (item: T) => { name: string; host?: string | null; label?: string | null }, chosen: (list: { name: string }[]) => { name: string }[]): T[] {
  const names = new Set(chosen(items.map(named)).map((n) => n.name));
  return items.filter((item) => names.has(named(item).name));
}

/** What a run is handed: what the goal names, and where it speaks of a kind without naming one, all of that kind. */
export function ownForRun(userId: string | null | undefined, text: string): OwnAccess {
  if (!userId) return NO_ACCESS;
  return {
    servers: pick(ownServers(userId), serverNamed, (list) => relevantTo(list, text, GENERIC.server, { offerAll: true })),
    accounts: pick(ownAccounts(userId), accountNamed, (list) => relevantTo(list, text, GENERIC.site, { offerAll: true })),
    keys: pick(ownKeys(userId), keyNamed, (list) => relevantTo(list, text, GENERIC.key, { offerAll: true })),
  };
}

/** What a task of the run is handed, by its own text among the texts of all the run's tasks. */
export function ownForTask(run: OwnAccess, taskText: string, allTaskTexts: readonly string[]): OwnAccess {
  return {
    servers: pick(run.servers, serverNamed, (list) => relevantToTask(list, taskText, allTaskTexts, GENERIC.server)),
    accounts: pick(run.accounts, accountNamed, (list) => relevantToTask(list, taskText, allTaskTexts, GENERIC.site)),
    keys: pick(run.keys, keyNamed, (list) => relevantToTask(list, taskText, allTaskTexts, GENERIC.key)),
  };
}

export function hasAccess(own: OwnAccess): boolean {
  return own.servers.length + own.accounts.length + own.keys.length > 0;
}

/** What the one who plans is told about it. Empty when the run is handed nothing. */
export function ownForPlan(own: OwnAccess, browser: boolean): string {
  if (!hasAccess(own)) return "";
  const lines: string[] = [];
  if (own.servers.length > 0) {
    lines.push(
      `- Servers, for commands over SSH: ${own.servers.map((s) => `${s.name} (${s.username}@${s.host}${s.notes ? `; ${s.notes.replace(/\s+/g, " ").trim()}` : ""})`).join("; ")}.`,
    );
  }
  if (own.accounts.length > 0) {
    lines.push(
      browser
        ? `- Site accounts, to sign in with in a real browser: ${own.accounts.map((a) => `${a.name} (${a.username} at ${siteHost(a.siteUrl) || a.siteUrl})`).join("; ")}.`
        : `- Site accounts (${own.accounts.map((a) => a.name).join(", ")}): no browser is set up on this installation, so nothing can be signed in to in this run. Have the last task say so plainly.`,
    );
  }
  if (own.keys.length > 0) {
    lines.push(
      `- Keys, which the app puts in where an agent writes their name: ${own.keys.map((k) => `${keyMark(k.name)} (${k.label}${siteOfKey(k.site) ? `, for ${siteOfKey(k.site)}` : ""})`).join("; ")}.`,
    );
  }
  return (
    "\n\nThe person handed over access of their own for this work. Every agent can work with it, whatever its other tools are: " +
    "give a task that needs it to the agent whose role fits the work, and name the server, the site account or the key in the task's " +
    "objective exactly as it is named here, since a task is handed what its objective names.\n" +
    lines.join("\n") +
    "\nPlan a task that looks at what is there before one that changes it, and one that checks the result afterwards."
  );
}

/** What the agent of a task is told about what it was handed. Empty when it was handed nothing. */
export function ownForAgent(own: OwnAccess, browser: boolean): string {
  if (!hasAccess(own)) return "";
  return (
    "\n\nThe person handed over access of their own for this work (kept by the app; you are never shown a password and need none):\n" +
    accessForModel(
      own.servers,
      own.accounts,
      own.keys.map((k) => ({ name: k.name, label: k.label, site: k.site })),
      browser,
    )
  );
}
