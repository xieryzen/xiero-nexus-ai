/**
 * Access an account hands to the AI in a conversation: the rules that need
 * no database and no network. Pure: used by the server, by the pages and by
 * the tests.
 *
 * A person writes how to sign in to a server, to a web site, or the key of
 * an API, in a chat or in what a project is to do. The app takes the
 * password out of the text before a model is asked, keeps it encrypted, and
 * gives the AI a name for it. From then on the assistant in every
 * conversation of that account, and the agents in its runs, can work with
 * it, without anything being set up on the Servers or the Browser page.
 * What an account hands over is its own: nobody else's chat or run uses it.
 */

/** Who may hand access over in a conversation (OWN_ACCESS). */
export const OWN_ACCESS_MODES = ["everyone", "admins", "owners", "off"] as const;
export type OwnAccessMode = (typeof OWN_ACCESS_MODES)[number];

/** What OWN_ACCESS says. Everyone, unless it names fewer. */
export function ownAccessMode(value: string | undefined | null): OwnAccessMode {
  const said = (value ?? "").trim().toLowerCase();
  if (said === "0" || said === "false" || said === "no" || said === "none") return "off";
  return (OWN_ACCESS_MODES as readonly string[]).includes(said) ? (said as OwnAccessMode) : "everyone";
}

/** Whether an account with this role may hand access over, and work with what it handed over. */
export function mayHandOver(role: string | null | undefined, mode: OwnAccessMode): boolean {
  if (mode === "off") return false;
  if (role === "owner") return true;
  if (mode === "owners") return false;
  if (role === "admin") return true;
  return mode === "everyone" && role === "user";
}

/** What one account can have kept. */
export const OWN_SERVERS_MAX = 20;
export const OWN_SITES_MAX = 20;
export const OWN_KEYS_MAX = 50;
/** What one conversation, or one task of a run, is handed of each. */
export const HANDED_AT_ONCE = 6;
/** Sign-ins the app tries for an account in a minute, to keep what a conversation hands over. */
export const KEEPS_PER_MINUTE = 12;

// ─── Names ───────────────────────────────────────────────────────────────────

function slug(text: string, max: number): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, max)
    .replace(/[^a-z0-9]+$/g, "");
}

/** The name a machine is kept under, from where it is: "vps-103-150-60-19", "srv1.example.com". */
export function serverNameFor(host: string): string {
  const bare = host.trim().toLowerCase();
  if (/^[\d.]+$/.test(bare)) return `vps-${bare.replace(/\./g, "-")}`;
  return slug(bare, 36) || "server";
}

/** The name a sign-in to a site is kept under: the site's host. */
export function accountNameFor(url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    host = url;
  }
  return slug(host, 36) || "site";
}

/** The name a key is kept under, from what the person called it: "discord-bot-token". */
export function keyNameFor(label: string): string {
  return slug(label.replace(/\s+/g, "-"), 36) || "key";
}

/** A name that is not taken: the name itself, or with a number after it. */
export function freeName(base: string, taken: ReadonlySet<string>, max = 40): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const tail = `-${n}`;
    const name = `${base.slice(0, max - tail.length)}${tail}`;
    if (!taken.has(name)) return name;
  }
  return `${base.slice(0, max - 9)}-${Date.now().toString(36)}`;
}

// ─── Keys ────────────────────────────────────────────────────────────────────

/** How a key is named where its value belongs: {{key:discord-bot-token}}. */
export const KEY_MARK = /\{\{\s*key\s*:\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*\}\}/g;

export function keyMark(name: string): string {
  return `{{key:${name}}}`;
}

/** The keys a text names, each once, lower-case. */
export function keysNamed(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(KEY_MARK)) names.add(m[1]!.toLowerCase());
  return [...names];
}

/** A text with the values of its keys in place. A name without a value stays as it is written. */
export function fillKeys(text: string, values: ReadonlyMap<string, string>): string {
  return text.replace(KEY_MARK, (whole, name: string) => values.get(name.toLowerCase()) ?? whole);
}

/**
 * A text without the values of keys: each is replaced by how the key is
 * named. What a machine or an API prints back must not show a model, a log
 * or a page what the app put in.
 */
export function hideValues(text: string, values: ReadonlyMap<string, string>): string {
  let out = text;
  // The longest first, so that a value that holds another one goes whole.
  for (const [name, value] of [...values].sort((a, b) => b[1].length - a[1].length)) {
    if (value.length < 4) continue;
    out = out.split(value).join(keyMark(name));
  }
  return out;
}

/** The host of a site as a key is tied to it: lower-case, without "www." and without a port. Empty when it is none. */
export function siteOfKey(input: string | null | undefined): string {
  const raw = (input ?? "").trim().toLowerCase();
  if (!raw) return "";
  let host = raw;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`).hostname;
  } catch {
    return "";
  }
  host = host.replace(/^www\./, "");
  // A name with a dot in it, or an address: a panel on a machine of one's own has no name.
  if (/^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/.test(host)) return host;
  return /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,23}$/.test(host) ? host : "";
}

/**
 * Whether a key may be sent to a host in a web request: to the site it is
 * for, and to what is under it. A key that is tied to no site is sent to
 * none: it can be written into a command on the person's own server, and
 * nowhere else.
 */
export function keyMayGoTo(site: string | null | undefined, host: string): boolean {
  const s = siteOfKey(site);
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (!s || !h) return false;
  if (h === s) return true;
  // An address has nothing under it.
  if (/^[\d.]+$/.test(s)) return false;
  return h === `www.${s}` || h.endsWith(`.${s}`);
}

// ─── What a text is about ────────────────────────────────────────────────────

/** Whether a text holds a name or an address as a word of its own: "1.2.3.4" is not in "11.2.3.45", "example.com" not in "app.example.com". */
export function says(text: string, word: string): boolean {
  const t = text.toLowerCase();
  const w = word.toLowerCase();
  if (!w) return false;
  for (let at = t.indexOf(w); at !== -1; at = t.indexOf(w, at + 1)) {
    const before = at > 0 ? t[at - 1]! : " ";
    const after = at + w.length < t.length ? t[at + w.length]! : " ";
    const next = at + w.length + 1 < t.length ? t[at + w.length + 1]! : " ";
    if (/[a-z0-9_.-]/.test(before)) continue;
    if (/[a-z0-9_-]/.test(after)) continue;
    if (after === "." && /[a-z0-9]/.test(next)) continue;
    return true;
  }
  return false;
}

export interface Named {
  name: string;
  /** Where it is: the address of a machine, the host of a site. */
  host?: string | null;
  /** What the person called it. */
  label?: string | null;
}

/** Words that say a kind of thing without naming one. */
export const GENERIC = {
  server: /\b(vps|servers?|ssh|deploy\w*|hosting|mesin)\b/i,
  site: /\b(log ?in|sign ?in|masuk|akun|accounts?|panel|dashboard|website|situs)\b/i,
  key: /\b(tokens?|api[ _-]?keys?|keys?|kunci|bot)\b/i,
} as const;

/**
 * What of an account's access a piece of work is handed: what its text
 * names, by name or by address. Where it names none but speaks of the kind
 * ("deploy it to my VPS") and there is exactly one of that kind, that one.
 * Otherwise nothing: an agent whose task is not about a server is not
 * handed one.
 *
 * `offerAll`: where the text speaks of the kind and names none of several,
 * all of them. For the one who plans, who then names the one a task is
 * about; never for the task itself.
 */
export function relevantTo<T extends Named>(items: readonly T[], text: string, generic: RegExp, opts: { offerAll?: boolean } = {}): T[] {
  if (items.length === 0 || !text.trim()) return [];
  const named = items.filter(
    (item) => says(text, item.name) || Boolean(item.host && says(text, item.host)) || Boolean(item.label && item.label.length >= 5 && says(text, item.label)),
  );
  if (named.length > 0) return named.slice(0, HANDED_AT_ONCE);
  if (!generic.test(text)) return [];
  if (items.length === 1) return [items[0]!];
  return opts.offerAll ? items.slice(0, HANDED_AT_ONCE) : [];
}

/**
 * What a task of a run is handed, of what the run works with. As above, by
 * the task's own text. Where no task of the run is about any of it (a
 * workflow whose steps are written for every project, and only the goal
 * says where the work is done), every task is handed all of it: the goal
 * is about it, and nothing else in the run could reach it.
 */
export function relevantToTask<T extends Named>(items: readonly T[], taskText: string, allTaskTexts: readonly string[], generic: RegExp): T[] {
  if (items.length === 0) return [];
  const mine = relevantTo(items, taskText, generic);
  if (mine.length > 0) return mine;
  const somewhere = allTaskTexts.some((text) => relevantTo(items, text, generic).length > 0);
  return somewhere ? [] : items.slice(0, HANDED_AT_ONCE);
}

// ─── What is said about it ───────────────────────────────────────────────────

/** What the app made of one thing a message handed over. */
export interface Kept {
  kind: "server" | "site" | "key";
  /** The name it is kept under. Empty when nothing was kept. */
  name: string;
  /** Where it is, without what signs in: "root@103.150.60.19:22", "admin at panel.example.com", "Discord bot token". */
  where: string;
  ok: boolean;
  /** It was there already and what signs in was replaced. */
  updated: boolean;
  /** What was seen when it was tried, or why it was not kept. For a person and for the model. */
  note: string;
}

/** What stands in a message where a secret stood. */
export function markFor(what: string, kept: Kept): string {
  return kept.ok ? `[${what} kept by the app as "${kept.name}"]` : `[${what} taken out by the app]`;
}

/** What the model is told, after a message, of what the app took out of it. */
export function keptForModel(kept: readonly Kept[]): string {
  if (kept.length === 0) return "";
  const lines = kept.map((k) => {
    if (!k.ok) return `- ${k.kind === "server" ? "Server" : k.kind === "site" ? "Site account" : "Key"} ${k.where}: NOT kept. ${k.note}`;
    if (k.kind === "server") return `- Server "${k.name}" (${k.where}): ${k.updated ? "kept again with the new sign-in" : "kept"}. ${k.note} Work on it with run_on_server.`;
    if (k.kind === "site") return `- Site account "${k.name}" (${k.where}): ${k.updated ? "kept again with the new password" : "kept"}. ${k.note}`;
    return `- Key "${k.name}" (${k.where}): ${k.updated ? "kept again with the new value" : "kept"}. ${k.note}`;
  });
  return (
    "\n\n(Note from the app, not from the person: what signs in was taken out of this message before you were shown it, and is kept encrypted. " +
    "You are never shown it and do not need it.\n" +
    lines.join("\n") +
    "\nWhere something was not kept, say so plainly and say why; do not ask the person to send a password to you again unless the details were wrong.)"
  );
}

export interface ServerLine {
  name: string;
  username: string;
  host: string;
  port: number;
  notes?: string | null;
}
export interface SiteLine {
  name: string;
  siteUrl: string;
  username: string;
  notes?: string | null;
}
export interface KeyLine {
  name: string;
  label: string;
  site?: string | null;
}

/** What a model is told about the keys it may use: their names, never their values. */
export function keysForModel(keys: readonly KeyLine[]): string {
  if (keys.length === 0) return "";
  return (
    "Keys the person handed over (you are never shown a value; the app puts it in where you write the name):\n" +
    keys
      .map(
        (k) =>
          `- ${keyMark(k.name)}: ${k.label}` +
          (siteOfKey(k.site)
            ? `. In a web request it is sent only to ${siteOfKey(k.site)}; in a command on a server it can be written anywhere.`
            : ". It is tied to no site, so it is sent in no web request; it can be written into a command on a server."),
      )
      .join("\n") +
    "\nWrite the name exactly as shown, for example in a header: Authorization: Bearer {{key:name}}. Never ask for the value and never print one."
  );
}

/** What the assistant of a chat is told about everything the account handed over. */
export function accessForModel(servers: readonly ServerLine[], sites: readonly SiteLine[], keys: readonly KeyLine[], browser: boolean): string {
  const parts: string[] = [];
  if (servers.length > 0) {
    parts.push(
      "Servers you can work on with run_on_server (signed in already; you need no password):\n" +
        servers.map((s) => `- ${s.name}: ${s.username}@${s.host}${s.port === 22 ? "" : `:${s.port}`}${s.notes ? ` (${s.notes})` : ""}`).join("\n"),
    );
  }
  if (sites.length > 0) {
    parts.push(
      (browser
        ? "Site accounts you can sign in with in the browser (use_browser, action sign_in; the app types the password):\n"
        : "Site accounts that are kept (no browser is set up on this installation, so they cannot be signed in to from here):\n") +
        sites.map((s) => `- ${s.name}: ${s.username} at ${s.siteUrl}${s.notes ? ` (${s.notes})` : ""}`).join("\n"),
    );
  }
  const keyText = keysForModel(keys);
  if (keyText) parts.push(keyText);
  return parts.join("\n\n");
}
