/**
 * What a person hands over in a conversation: how to sign in to a server,
 * to a web site, a key of an API or an app. Found by its shape, without a
 * model, so that a password is taken out of a message before any model is
 * asked and before the message is kept. Pure: no database, no network.
 *
 * What is found is tried and kept by store.ts. What this does not recognise
 * stays in the text; the assistant can still keep it with its tool.
 */

export interface Span {
  start: number;
  end: number;
}

export interface FoundServer {
  kind: "server";
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface FoundSite {
  kind: "site";
  /** The page where one signs in. */
  url: string;
  username: string;
  password: string;
}

export interface FoundKey {
  kind: "key";
  /** What it is, in the person's words where they said it: "Discord bot token". */
  label: string;
  value: string;
  /** The site it is for, when the message or the key's shape says so. */
  site: string | null;
}

export type FoundItem = FoundServer | FoundSite | FoundKey;

export interface Found {
  item: FoundItem;
  /** Where its secrets stand in the text, and what each is. */
  secrets: (Span & { what: "password" | "private key" | "passphrase" | "key" })[];
}

// ─── Shapes ──────────────────────────────────────────────────────────────────

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,23}$/i;
/** What ends a name that is a file and not a host: "notes.txt", "index.php". */
const FILE_ENDINGS = /\.(?:txt|md|json|ya?ml|js|ts|tsx|jsx|py|php|html?|css|sh|env|log|sql|zip|png|jpe?g|gif|pdf|conf|ini|toml|lock|jar|java|go|rs|c|h|cpp)$/i;

export function isIpv4(text: string): boolean {
  return IPV4.test(text);
}

/** Whether a text is the name or the address of a machine: an IPv4 address or a full domain name. */
export function isHost(text: string): boolean {
  return IPV4.test(text) || (DOMAIN.test(text) && !FILE_ENDINGS.test(text));
}

/** Keys that say by their shape what they are. `site` is the host they are for, when the shape says it. */
const KNOWN_KEYS: { re: RegExp; label: string; site: string | null }[] = [
  { re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, label: "GitHub token", site: "github.com" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g, label: "GitHub token", site: "github.com" },
  { re: /\bsk-ant-[A-Za-z0-9_-]{24,}/g, label: "Anthropic API key", site: "anthropic.com" },
  { re: /\bsk-or-[A-Za-z0-9_-]{24,}/g, label: "OpenRouter API key", site: "openrouter.ai" },
  { re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g, label: "API key", site: null },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{20,}/g, label: "Slack token", site: "slack.com" },
  { re: /\b[MNO][A-Za-z\d_-]{23,25}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}/g, label: "Discord bot token", site: "discord.com" },
  { re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, label: "Telegram bot token", site: "api.telegram.org" },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, label: "Google API key", site: "googleapis.com" },
  { re: /\bgsk_[A-Za-z0-9]{40,}\b/g, label: "Groq API key", site: "groq.com" },
  { re: /\bhf_[A-Za-z0-9]{30,}\b/g, label: "Hugging Face token", site: "huggingface.co" },
  { re: /\bdop_v1_[a-f0-9]{64}\b/g, label: "DigitalOcean token", site: "digitalocean.com" },
  { re: /\bnpm_[A-Za-z0-9]{36}\b/g, label: "npm token", site: "npmjs.org" },
  { re: /\bptl[ac]_[A-Za-z0-9]{40,}\b/g, label: "Pterodactyl API key", site: null },
  { re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, label: "GitLab token", site: "gitlab.com" },
  { re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}\b/g, label: "Stripe key", site: "stripe.com" },
];

/** Services a key is for when the person names them: the host a key of theirs may be sent to. */
const SERVICES: [RegExp, string, string][] = [
  [/\bdiscord\b/i, "Discord", "discord.com"],
  [/\btelegram\b/i, "Telegram", "api.telegram.org"],
  [/\bgithub\b/i, "GitHub", "github.com"],
  [/\bgitlab\b/i, "GitLab", "gitlab.com"],
  [/\bcloudflare\b/i, "Cloudflare", "cloudflare.com"],
  [/\bopenai\b/i, "OpenAI", "openai.com"],
  [/\banthropic|claude\b/i, "Anthropic", "anthropic.com"],
  [/\bopenrouter\b/i, "OpenRouter", "openrouter.ai"],
  [/\bgroq\b/i, "Groq", "groq.com"],
  [/\bmistral\b/i, "Mistral", "mistral.ai"],
  [/\bgemini|google\b/i, "Google", "googleapis.com"],
  [/\bvercel\b/i, "Vercel", "vercel.com"],
  [/\bnetlify\b/i, "Netlify", "netlify.com"],
  [/\bdigital\s?ocean\b/i, "DigitalOcean", "digitalocean.com"],
  [/\bhetzner\b/i, "Hetzner", "hetzner.cloud"],
  [/\bstripe\b/i, "Stripe", "stripe.com"],
  [/\bslack\b/i, "Slack", "slack.com"],
  [/\bnotion\b/i, "Notion", "notion.com"],
  [/\bsupabase\b/i, "Supabase", "supabase.co"],
  [/\bhugging\s?face\b/i, "Hugging Face", "huggingface.co"],
  [/\bopenweather(?:map)?\b/i, "OpenWeather", "openweathermap.org"],
  [/\bmidtrans\b/i, "Midtrans", "midtrans.com"],
  [/\bxendit\b/i, "Xendit", "xendit.co"],
  [/\btwilio\b/i, "Twilio", "twilio.com"],
  [/\bsendgrid\b/i, "SendGrid", "sendgrid.com"],
];

// ─── Fields ──────────────────────────────────────────────────────────────────

type FieldKind = "pass" | "passphrase" | "user" | "host" | "port" | "url" | "token";

interface Field {
  kind: FieldKind;
  value: string;
  /** Where the value stands. */
  start: number;
  end: number;
  /** The words in front of it, for what a key is called. */
  label: string;
  /** Said with ":" or "=", not only with a word in front. */
  explicit: boolean;
  used?: boolean;
}

const WORDS: Record<Exclude<FieldKind, "port" | "passphrase">, ReadonlySet<string>> = {
  pass: new Set(["password", "passwd", "passwort", "pass", "pwd", "pw", "sandi", "katasandi", "kata sandi", "pswd"]),
  user: new Set(["username", "user", "usr", "login", "pengguna", "nama pengguna", "email", "e-mail", "mail", "akun", "account", "user name"]),
  host: new Set(["ip", "host", "hostname", "server", "vps", "address", "alamat", "ip address", "alamat ip", "ip vps", "ip server", "domain"]),
  url: new Set(["url", "link", "site", "situs", "website", "web", "panel", "login url", "alamat web"]),
  token: new Set(["token", "apikey", "api key", "api-key", "api_key", "secret", "key", "bearer", "access token", "bot token", "auth token", "secret key", "client secret", "kunci api"]),
};

/** What kind of thing a label names: by its last words, so that "Bot Token Discord" and "MYSQL_PASSWORD" are both understood. */
function kindOfLabel(raw: string): FieldKind | null {
  const words = raw
    .toLowerCase()
    .replace(/[_.]+/g, " ")
    .replace(/[^a-z0-9 -]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0 || words.length > 5) return null;
  if (words.includes("passphrase")) return "passphrase";
  if (words.includes("port")) return "port";
  const has = (set: ReadonlySet<string>) => {
    for (let i = 0; i < words.length; i++) {
      if (set.has(words[i]!)) return true;
      if (i + 1 < words.length && set.has(`${words[i]} ${words[i + 1]}`)) return true;
    }
    return false;
  };
  // A password before anything else: "user password", "ssh pass".
  if (has(WORDS.pass)) return "pass";
  if (has(WORDS.token)) return "token";
  if (has(WORDS.url)) return "url";
  if (has(WORDS.user)) return "user";
  if (has(WORDS.host)) return "host";
  return null;
}

/** A value as it was meant: without the quotes around it and the comma after it. */
function trimValue(text: string, start: number, explicit: boolean): { value: string; start: number } {
  let value = text;
  let at = start;
  const quoted = /^(["'`])([^\n]*)\1[,;.]?$/.exec(value);
  if (quoted && quoted[2]) return { value: quoted[2], start: at + 1 };
  // What a sentence puts after a value. A password may end in a dot or a
  // comma; one that was said with ":" keeps a dot, a sentence's comma goes.
  value = value.replace(/[,;]+$/, "");
  if (!explicit) value = value.replace(/\.+$/, "");
  if (value.endsWith(")") && !value.includes("(")) value = value.slice(0, -1);
  const lead = /^[<([{]+/.exec(value);
  if (lead && /[>)\]}]$/.test(value)) {
    value = value.slice(lead[0].length, -1);
    at += lead[0].length;
  }
  return { value, start: at };
}

/** Whether a word after "pw" or "pass", without ":" or "=", can be a password and not the next word of a sentence. */
function looksSecret(value: string): boolean {
  if (value.length < 4 || value.length > 128) return false;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
  return kinds >= 2;
}

function looksLikeKey(value: string): boolean {
  return value.length >= 12 && value.length <= 512 && /^[A-Za-z0-9_\-.:=/+~]+$/.test(value) && /[0-9]/.test(value) && /[A-Za-z]/.test(value);
}

function fieldsOf(text: string, taken: Span[]): Field[] {
  const fields: Field[] = [];
  const free = (start: number, end: number) => !taken.some((s) => start < s.end && end > s.start) && !fields.some((f) => start < f.end && end > f.start);
  const add = (kind: FieldKind, raw: string, rawStart: number, label: string, explicit: boolean) => {
    const { value, start } = trimValue(raw, rawStart, explicit);
    if (!value || !free(start, start + value.length)) return;
    if (kind === "port" && !/^\d{1,5}$/.test(value)) return;
    if (kind === "host") {
      // "1.2.3.4:2222" says the port as well.
      const withPort = /^(.+?):(\d{2,5})$/.exec(value);
      const host = (withPort ? withPort[1]! : value).replace(/^\[|\]$/g, "");
      if (!isHost(host)) return;
      fields.push({ kind, value: host, start, end: start + host.length, label, explicit });
      if (withPort) fields.push({ kind: "port", value: withPort[2]!, start: start + withPort[1]!.length + 1, end: start + value.length, label, explicit });
      return;
    }
    if (kind === "url") {
      if (!/^https?:\/\/\S+$/i.test(value) && !isHost(value.replace(/[/?#].*$/, ""))) return;
      fields.push({ kind, value: /^https?:\/\//i.test(value) ? value : `https://${value}`, start, end: start + value.length, label, explicit });
      return;
    }
    if (kind === "user" && !/^[A-Za-z0-9_][A-Za-z0-9_.@+-]{0,127}$/.test(value)) return;
    if ((kind === "pass" || kind === "passphrase") && !explicit && !looksSecret(value)) return;
    if (kind === "pass" && value.length > 256) return;
    if (kind === "token" && !looksLikeKey(value)) return;
    fields.push({ kind, value, start, end: start + value.length, label, explicit });
  };

  // "Label: value", "label = value", a pair on a line or several on one.
  const pair = /(^|[\s,;|(])([A-Za-z][A-Za-z0-9 _.-]{0,40}?)[ \t]*(?::|=>|->|=)[ \t]*("[^"\n]+"|'[^'\n]+'|`[^`\n]+`|[^\s]+)/g;
  for (let m = pair.exec(text); m; m = pair.exec(text)) {
    const label = m[2]!.trim();
    // "https://…" is an address, not a label "https" with a value.
    if (/^https?$/i.test(label)) continue;
    const kind = kindOfLabel(label);
    if (!kind) {
      // The pair is not one of ours: what follows its label may be.
      pair.lastIndex = m.index + m[1]!.length + m[2]!.length;
      continue;
    }
    const raw = m[3]!;
    add(kind, raw, m.index + m[0].length - raw.length, label, true);
  }

  // "user root pw abc123": a word and its value, without a sign between.
  const word = /(^|[\s,;|(])(username|user|usr|password|passwd|pass|pwd|pw|sandi|katasandi|ip|vps|server|host|hostname|port|token|bearer)[ \t]+("[^"\n]+"|'[^'\n]+'|`[^`\n]+`|[^\s]+)/gi;
  for (let m = word.exec(text); m; m = word.exec(text)) {
    const kind = kindOfLabel(m[2]!);
    const raw = m[3]!;
    if (kind) add(kind, raw, m.index + m[0].length - raw.length, m[2]!, false);
    word.lastIndex = m.index + m[1]!.length + m[2]!.length;
  }

  // "root@1.2.3.4", and "ssh deploy@example.com -p 2222".
  const at = /(^|[\s"'`(])(ssh[ \t]+(?:-\S+[ \t]+(?:\d+[ \t]+)?)*)?([a-z_][a-z0-9_.-]{0,31})@((?:\d{1,3}\.){3}\d{1,3}|[a-z0-9.-]+\.[a-z]{2,24})(?::(\d{2,5}))?(?=$|[\s"'`),;])/gi;
  for (let m = at.exec(text); m; m = at.exec(text)) {
    const host = m[4]!;
    // Without "ssh" in front, a name at a domain is an email address.
    if (!m[2] && !isIpv4(host)) continue;
    if (!isHost(host)) continue;
    const userStart = m.index + m[1]!.length + (m[2]?.length ?? 0);
    const hostStart = userStart + m[3]!.length + 1;
    if (!free(userStart, hostStart + host.length)) continue;
    fields.push({ kind: "user", value: m[3]!, start: userStart, end: userStart + m[3]!.length, label: "ssh", explicit: true });
    fields.push({ kind: "host", value: host, start: hostStart, end: hostStart + host.length, label: "ssh", explicit: true });
    if (m[5]) fields.push({ kind: "port", value: m[5], start: hostStart + host.length + 1, end: hostStart + host.length + 1 + m[5].length, label: "ssh", explicit: true });
  }
  const sshPort = /\bssh\b[^\n]*?[ \t]-p[ \t]*(\d{2,5})\b/gi;
  for (let m = sshPort.exec(text); m; m = sshPort.exec(text)) {
    const start = m.index + m[0].length - m[1]!.length;
    if (free(start, start + m[1]!.length)) fields.push({ kind: "port", value: m[1]!, start, end: start + m[1]!.length, label: "ssh", explicit: true });
  }

  // An address that stands alone: "https://panel.example.com/login", "103.150.60.19".
  const link = /https?:\/\/[^\s<>"'`)\]]+/gi;
  for (let m = link.exec(text); m; m = link.exec(text)) {
    const value = m[0].replace(/[.,;!?]+$/, "");
    if (free(m.index, m.index + value.length)) fields.push({ kind: "url", value, start: m.index, end: m.index + value.length, label: "", explicit: false });
  }
  const ip = /(^|[^\w.])((?:\d{1,3}\.){3}\d{1,3})(?::(\d{2,5}))?(?![\w.]*\w)/g;
  for (let m = ip.exec(text); m; m = ip.exec(text)) {
    const start = m.index + m[1]!.length;
    if (!isIpv4(m[2]!) || !free(start, start + m[2]!.length)) continue;
    fields.push({ kind: "host", value: m[2]!, start, end: start + m[2]!.length, label: "", explicit: false });
    if (m[3]) fields.push({ kind: "port", value: m[3], start: start + m[2]!.length + 1, end: start + m[2]!.length + 1 + m[3].length, label: "", explicit: false });
  }

  // A name that stands alone: "panel.example.com", "example.com/login".
  const bare = /(^|[\s"'`(])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,23})(?::(\d{2,5}))?(\/[^\s<>"'`)\]]*)?(?=$|[\s"'`),;]|\.(?:\s|$))/gi;
  for (let m = bare.exec(text); m; m = bare.exec(text)) {
    const start = m.index + m[1]!.length;
    const name = m[2]!;
    if (!isHost(name) || isIpv4(name)) continue;
    const whole = m[0].slice(m[1]!.length);
    if (!free(start, start + whole.length)) continue;
    if (m[4]) {
      fields.push({ kind: "url", value: `https://${whole.replace(/[.,;!?]+$/, "")}`, start, end: start + whole.length, label: "", explicit: false });
      continue;
    }
    fields.push({ kind: "host", value: name, start, end: start + name.length, label: "", explicit: false });
    if (m[3]) fields.push({ kind: "port", value: m[3], start: start + name.length + 1, end: start + name.length + 1 + m[3].length, label: "", explicit: false });
  }

  return fields.sort((a, b) => a.start - b.start);
}

// ─── What the fields make ────────────────────────────────────────────────────

const SSH_WORDS = /\b(ssh|vps|root|dedicated|ubuntu|debian|centos|almalinux|linux|sudo|droplet|vm)\b/i;
/** Words that say a machine even where "login" or "panel" is said as well. */
const SSH_FIRST = /\b(ssh|vps|root)\b/i;
const WEB_WORDS = /\b(login|log in|sign in|masuk|panel|dashboard|cpanel|website|web|situs|site|admin page|wp-admin)\b/i;

/** The parts of a text that are apart from each other: what an empty line divides. */
function blocksOf(text: string): Span[] {
  const blocks: Span[] = [];
  const gap = /\n[ \t]*\n/g;
  let start = 0;
  for (let m = gap.exec(text); m; m = gap.exec(text)) {
    if (m.index > start) blocks.push({ start, end: m.index });
    start = m.index + m[0].length;
  }
  if (start < text.length) blocks.push({ start, end: text.length });
  return blocks.length > 0 ? blocks : [{ start: 0, end: text.length }];
}

/**
 * How far a field stands from a place. What a password opens is written
 * before it far more often than after it, so what follows counts as four
 * times as far.
 */
function farFrom(field: Field | undefined, at: number): number {
  if (!field) return Infinity;
  return field.start <= at ? at - field.start : (field.start - at) * 4 + 1;
}

/** The field of a kind that stands nearest to a place, among the ones that were not used; before it rather than after. */
function nearest(fields: Field[], kind: FieldKind, at: number, within: Span | null, reuse = false): Field | undefined {
  let best: Field | undefined;
  let bestCost = Infinity;
  for (const f of fields) {
    if (f.kind !== kind || (f.used && !reuse)) continue;
    if (within && (f.start < within.start || f.end > within.end)) continue;
    const cost = farFrom(f, at);
    if (cost < bestCost) {
      best = f;
      bestCost = cost;
    }
  }
  return best;
}

function labelOfKey(field: Field, around: string): { label: string; site: string | null } {
  const service = SERVICES.find(([re]) => re.test(field.label) || re.test(around));
  const words = field.label.replace(/[_.]+/g, " ").replace(/\s+/g, " ").trim();
  const named = words && !/^(token|key|secret|api key|apikey|bearer)$/i.test(words) ? words : "";
  if (service) {
    const what = /bot/i.test(field.label) || /\bbot\b/i.test(around) ? "bot token" : /secret/i.test(field.label) ? "secret" : /token/i.test(field.label) ? "token" : "API key";
    return { label: `${service[1]} ${what}`, site: service[2] };
  }
  return { label: (named || "API key").slice(0, 60), site: null };
}

/**
 * What a text hands over. A server where a password or a private key comes
 * with the address of a machine; a site where a password comes with a web
 * address and a name to sign in as; a key where something is called a token
 * or a key, or has the shape of one. A password that comes with neither is
 * left where it is: it is not known what it opens.
 */
export function findAccess(text: string): Found[] {
  if (!text || text.length > 64_000) return [];
  const found: Found[] = [];
  const taken: Span[] = [];

  // Private keys first: nothing inside one is a field.
  const keyBlocks: (Span & { value: string })[] = [];
  const pem = /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]+?-----END \1PRIVATE KEY-----/g;
  for (let m = pem.exec(text); m; m = pem.exec(text)) {
    keyBlocks.push({ start: m.index, end: m.index + m[0].length, value: m[0] });
    taken.push({ start: m.index, end: m.index + m[0].length });
  }

  // Keys that say what they are by their shape.
  const shaped: { span: Span; label: string; site: string | null; value: string }[] = [];
  for (const known of KNOWN_KEYS) {
    known.re.lastIndex = 0;
    for (let m = known.re.exec(text); m; m = known.re.exec(text)) {
      const span = { start: m.index, end: m.index + m[0].length };
      if (taken.some((s) => span.start < s.end && span.end > s.start)) continue;
      taken.push(span);
      shaped.push({ span, label: known.label, site: known.site, value: m[0] });
    }
  }

  const fields = fieldsOf(text, taken);
  const blocks = blocksOf(text);
  const blockOf = (at: number): Span => blocks.find((b) => at >= b.start && at <= b.end) ?? { start: 0, end: text.length };
  const passwords = fields.filter((f) => f.kind === "pass");
  // With one password in all, everything in the message is about it.
  const whole = passwords.length + keyBlocks.length <= 1;

  const hostFor = (at: number, block: Span) => nearest(fields, "host", at, whole ? null : block) ?? nearest(fields, "host", at, whole ? null : block, true);
  const portFor = (host: Field, block: Span): number => {
    // The port that stands right after the host, else the one of the block.
    const next = fields.find((f) => f.kind === "port" && !f.used && f.start === host.end + 1) ?? nearest(fields, "port", host.start, whole ? null : block);
    if (!next) return 22;
    const port = Number(next.value);
    if (!(port >= 1 && port <= 65535)) return 22;
    next.used = true;
    return port;
  };

  // A private key signs in to the machine that is named with it.
  for (const key of keyBlocks) {
    const block = blockOf(key.start);
    const host = hostFor(key.start, block);
    if (!host) continue;
    const user = nearest(fields, "user", host.start, whole ? null : block);
    const phrase = nearest(fields, "passphrase", key.start, whole ? null : block) ?? (whole ? nearest(fields, "pass", key.start, null) : undefined);
    const port = portFor(host, block);
    host.used = true;
    if (user) user.used = true;
    if (phrase) phrase.used = true;
    found.push({
      item: { kind: "server", host: host.value, port, username: user?.value ?? "root", privateKey: `${key.value}\n`, ...(phrase ? { passphrase: phrase.value } : {}) },
      secrets: [{ start: key.start, end: key.end, what: "private key" }, ...(phrase ? [{ start: phrase.start, end: phrase.end, what: "passphrase" as const }] : [])],
    });
  }

  for (const pass of passwords) {
    if (pass.used) continue;
    const block = blockOf(pass.start);
    const scope = whole ? null : block;
    const around = whole ? text : text.slice(block.start, block.end);
    const host = hostFor(pass.start, block);
    const url = nearest(fields, "url", pass.start, scope);
    const user = nearest(fields, "user", pass.start, scope);
    const sshish = SSH_WORDS.test(around) || fields.some((f) => f.label === "ssh" && (!scope || (f.start >= scope.start && f.end <= scope.end)));
    const webish = Boolean(url) || WEB_WORDS.test(around);

    // Where a web address and a machine are both named, the password is of
    // the one it stands with.
    const siteFirst = Boolean(url && user && farFrom(url, pass.start) < farFrom(host, pass.start));
    // A machine: an address, and nothing that makes it a web site instead.
    const asServer = host && !siteFirst && (isIpv4(host.value) || (sshish && !webish) || (sshish && !url && SSH_FIRST.test(around)));
    if (host && asServer) {
      const port = portFor(host, block);
      host.used = true;
      pass.used = true;
      // An email address is not the account on a machine.
      const account = user && !user.value.includes("@") ? user : undefined;
      if (account) account.used = true;
      found.push({
        item: { kind: "server", host: host.value, port, username: account?.value ?? "root", password: pass.value },
        secrets: [{ start: pass.start, end: pass.end, what: "password" }],
      });
      continue;
    }
    // A site: where to sign in, and as whom.
    const where = url?.value ?? (host && webish && !isIpv4(host.value) ? `https://${host.value}` : null);
    if (where && user) {
      if (url) url.used = true;
      else if (host) host.used = true;
      user.used = true;
      pass.used = true;
      found.push({
        item: { kind: "site", url: where, username: user.value, password: pass.value },
        secrets: [{ start: pass.start, end: pass.end, what: "password" }],
      });
    }
  }

  // Keys: what is called one, and what has the shape of one.
  const lineOf = (at: number) => {
    const block = blockOf(at);
    return text.slice(block.start, block.end);
  };
  const siteNear = (at: number): string | null => {
    const scope = whole ? null : blockOf(at);
    const url = nearest(fields, "url", at, scope, true);
    const named = fields.filter((f) => f.kind === "host" && !isIpv4(f.value) && (!scope || (f.start >= scope.start && f.end <= scope.end)));
    const host = named.sort((a, b) => farFrom(a, at) - farFrom(b, at))[0];
    if (!url) return host ? host.value.toLowerCase().replace(/^www\./, "") : null;
    try {
      return new URL(url.value).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      return null;
    }
  };
  for (const field of fields) {
    if (field.kind !== "token" || field.used) continue;
    field.used = true;
    const named = labelOfKey(field, lineOf(field.start));
    found.push({
      item: { kind: "key", label: named.label, value: field.value, site: named.site ?? siteNear(field.start) },
      secrets: [{ start: field.start, end: field.end, what: "key" }],
    });
  }
  for (const key of shaped) {
    const service = SERVICES.find(([re]) => re.test(lineOf(key.span.start)));
    found.push({
      item: { kind: "key", label: key.label, value: key.value, site: key.site ?? service?.[2] ?? siteNear(key.span.start) },
      secrets: [{ ...key.span, what: "key" }],
    });
  }

  return found.sort((a, b) => (a.secrets[0]?.start ?? 0) - (b.secrets[0]?.start ?? 0));
}

/** A text with parts of it replaced. The parts must not overlap. */
export function replaceSpans(text: string, parts: readonly (Span & { with: string })[]): string {
  let out = "";
  let at = 0;
  for (const part of [...parts].sort((a, b) => a.start - b.start)) {
    if (part.start < at) continue;
    out += text.slice(at, part.start) + part.with;
    at = part.end;
  }
  return out + text.slice(at);
}
