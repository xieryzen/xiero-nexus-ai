import "server-only";
import type { AccessKey, User } from "@/db/schema";
import { ToolError, type LoopTool } from "../agent/loop";
import { KEY_MARK, fillKeys, hideValues, keyMark, keyMayGoTo, keysNamed, says, siteOfKey, type Kept } from "./rules";
import { keep, keyValues, noteKeyUse, type KeepOptions } from "./store";
import type { FoundItem } from "./find";

/**
 * The tools side of what an account handed over: keys that are put in where
 * a call names them, and the tool the assistant keeps with what the app did
 * not recognise in a message.
 */

/** The keys a piece of work may use: named by the AI, put in by the app, never shown. */
export interface KeySet {
  names: string[];
  /** A text with the values in place of the names: for the machine or the API alone. */
  fill(text: string): string;
  /** A text without the values: for the model, the log and the page. */
  hide(text: string): string;
  /** Why a key is not sent to a host in a web request, or null when it is. */
  refusal(name: string, host: string): string | null;
}

export function keySetOf(keys: readonly AccessKey[]): KeySet | null {
  if (keys.length === 0) return null;
  const values = keyValues(keys);
  const byName = new Map(keys.map((k) => [k.name, k] as const));
  const used = (text: string) => {
    const ids = keysNamed(text)
      .map((name) => byName.get(name)?.id)
      .filter((id): id is string => Boolean(id));
    if (ids.length > 0) noteKeyUse(ids);
  };
  return {
    names: [...byName.keys()],
    fill(text) {
      used(text);
      return fillKeys(text, values);
    },
    hide: (text) => hideValues(text, values),
    refusal(name, host) {
      const key = byName.get(name);
      if (!key) return `There is no key ${keyMark(name)}. The keys are: ${[...byName.keys()].map(keyMark).join(", ")}.`;
      if (keyMayGoTo(key.site, host)) return null;
      const site = siteOfKey(key.site);
      return site
        ? `The key ${keyMark(name)} is for ${site} and is not sent to ${host || "that address"}.`
        : `The key ${keyMark(name)} is tied to no site, so it is sent in no web request. Ask the person which site it is for.`;
    },
  };
}

function filled(value: unknown, keys: KeySet): unknown {
  if (typeof value === "string") return keys.fill(value);
  if (Array.isArray(value)) return value.map((v) => filled(v, keys));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, filled(v, keys)]));
  return value;
}

/**
 * A web request tool that puts keys in. A key is sent only to the site it is
 * for; what comes back is shown without it.
 */
export function withKeys(tool: LoopTool, keys: KeySet): LoopTool {
  return {
    ...tool,
    async run(args) {
      const named = keysNamed(JSON.stringify(args));
      if (named.length === 0) return tool.run(args);
      let host = "";
      try {
        host = new URL(String(args.url ?? "").replace(KEY_MARK, "x")).hostname;
      } catch {
        // The tool says what is wrong with the address.
      }
      for (const name of named) {
        const refusal = keys.refusal(name, host);
        if (refusal) throw new ToolError(refusal);
      }
      try {
        return keys.hide(await tool.run(filled(args, keys) as Record<string, unknown>));
      } catch (err) {
        if (err instanceof ToolError) throw new ToolError(keys.hide(err.message));
        throw err;
      }
    },
  };
}

export const KEEP_TOOL = "keep_access";

export interface KeepToolContext {
  user: Pick<User, "id" | "role">;
  meta?: Pick<KeepOptions, "ip" | "userAgent">;
  /** What the person wrote in this conversation: a key is tied to a site they named, not to one the model thought of. */
  personSaid(): string;
  /** After something was kept: what was kept, and the secrets that have to go from the conversation as it is stored. */
  onKept(kept: Kept, secrets: string[]): void;
}

function text(args: Record<string, unknown>, key: string, max = 4000): string {
  const value = args[key];
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * The tool the assistant keeps access with, for what a person wrote in a
 * shape the app did not recognise. It goes the same way as what the app
 * finds itself: a server is tried before it is kept.
 */
export function keepAccessTool(ctx: KeepToolContext): LoopTool {
  return {
    definition: {
      name: KEEP_TOOL,
      description:
        "Keep a sign-in or a key that the person wrote in this conversation and that you can still see in plain text, so that it is stored encrypted and you can work with it by name. " +
        'kind "server": host, username and password (or private_key) of a machine reached over SSH; the app signs in once to try it. ' +
        'kind "site": url of the sign-in page, username and password of an account on a web site. ' +
        'kind "key": label (what it is) and value of an API key, a bot token or another secret, and site (the host it is for) when the person said it. ' +
        "Only for what the person gave you. Do not repeat the secret in your answer afterwards.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["server", "site", "key"] },
          host: { type: "string", description: "server: the address or the name of the machine." },
          port: { type: "integer", description: "server: the SSH port. Default 22." },
          username: { type: "string", description: "server, site: the account to sign in as. Default root for a server." },
          password: { type: "string", description: "server, site: the password." },
          private_key: { type: "string", description: "server: the private key, the whole file, instead of a password." },
          passphrase: { type: "string", description: "server: the passphrase of the private key, when it has one." },
          url: { type: "string", description: "site: the page where one signs in, starting with https://." },
          label: { type: "string", description: "key: what it is, in a few words: Discord bot token." },
          value: { type: "string", description: "key: the key itself." },
          site: { type: "string", description: "key: the host it is for, as the person said it: discord.com." },
          name: { type: "string", description: "A short name to keep it under. Left out, the app makes one." },
          notes: { type: "string", description: "What it is for, in a few words." },
        },
        required: ["kind"],
      },
    },
    async run(args) {
      const kind = text(args, "kind", 10);
      const opts: KeepOptions = { name: text(args, "name", 40) || undefined, notes: text(args, "notes", 400) || undefined, ...ctx.meta };
      let item: FoundItem;
      const secrets: string[] = [];
      let aside = "";
      if (kind === "server") {
        const host = text(args, "host", 253);
        const password = typeof args.password === "string" ? args.password : "";
        const privateKey = typeof args.private_key === "string" ? args.private_key.trim() : "";
        if (!host) throw new ToolError('"host" is required for a server.');
        if (!password && !privateKey) throw new ToolError('A server needs "password" or "private_key".');
        const port = Number(args.port);
        item = {
          kind: "server",
          host,
          port: Number.isInteger(port) && port > 0 ? port : 22,
          username: text(args, "username", 64) || "root",
          ...(privateKey ? { privateKey: `${privateKey}\n`, passphrase: text(args, "passphrase", 500) || undefined } : { password }),
        };
        secrets.push(privateKey || password);
      } else if (kind === "site") {
        const url = text(args, "url", 2000);
        const username = text(args, "username", 200);
        const password = typeof args.password === "string" ? args.password : "";
        if (!url || !username || !password) throw new ToolError('A site account needs "url", "username" and "password".');
        item = { kind: "site", url: /^https?:\/\//i.test(url) ? url : `https://${url}`, username, password };
        secrets.push(password);
      } else if (kind === "key") {
        const value = typeof args.value === "string" ? args.value.trim() : "";
        if (!value) throw new ToolError('A key needs "value".');
        let site: string | null = siteOfKey(text(args, "site", 253)) || null;
        if (site && !says(ctx.personSaid(), site)) {
          aside = ` The site ${site} was not tied to it: the person did not name it in this conversation. Ask them which site the key is for.`;
          site = null;
        }
        item = { kind: "key", label: text(args, "label", 80) || "API key", value, site };
        secrets.push(value);
      } else {
        throw new ToolError('"kind" must be server, site or key.');
      }
      const kept = await keep(ctx.user, item, opts);
      // What was handed over goes from the stored conversation whether or not it could be kept.
      ctx.onKept(kept, secrets);
      if (!kept.ok) throw new ToolError(`Not kept. ${kept.note}`);
      return `${kept.updated ? "Kept again" : "Kept"} as "${kept.name}" (${kept.where}). ${kept.note}${aside}`;
    },
  };
}
