/**
 * Conversations on the Chat page: what needs no database. Pure: used by the
 * server, by the page and by the tests.
 */

import type { Kept } from "../access/rules";
import { callSummary } from "../browser/rules";

export const CHAT_TITLE_MAX = 80;
/** Messages of a conversation that a model is shown: the newest. */
export const HISTORY_MESSAGES = 40;
/** Characters of them, counted from the newest. */
export const HISTORY_CHARS = 60_000;
/** Model calls one answer may take, the answer itself included. */
export const CHAT_MAX_STEPS = 16;
/** How long one answer may work, with everything its tools do. */
export const ANSWER_MAX_MS = 30 * 60_000;
/** Conversations an account keeps; the ones written in longest ago make way. */
export const CHATS_KEPT = 300;
/** Longest message. */
export const MESSAGE_MAX_CHARS = 32_000;

/** One tool call of an answer, as the page shows it and as the next answer is told. */
export interface ToolNote {
  name: string;
  /** What it was called with, in a line. Never a secret. */
  summary: string;
  isError: boolean;
  durationMs: number;
  /** The start of what came back. */
  result: string;
}

export interface SourceNote {
  n: number;
  documentTitle: string;
  collectionName: string;
  excerpt: string;
}

/** What is kept with a message besides its text. */
export interface MessageDetails {
  /** Of a message: what the app took out of it and kept. */
  kept?: Kept[];
  /** Of an answer: the tools it used. */
  tools?: ToolNote[];
  /** The model that gave it. */
  model?: string;
  sources?: SourceNote[];
  knowledgeError?: string | null;
  /** What was put in front of the model from the account's memory. */
  remembered?: { notes: number; passages: number };
  /** Why it ended, when it did not end with the answer. */
  stopped?: "cancelled" | "max_steps" | "tokens" | "time";
  error?: string;
}

/** What a conversation is called until someone names it: the start of its first message. */
export function titleFrom(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const flat = (line ?? "").replace(/\s+/g, " ");
  if (!flat) return "New chat";
  return flat.length > CHAT_TITLE_MAX ? `${flat.slice(0, CHAT_TITLE_MAX - 1).trimEnd()}…` : flat;
}

/** What a later answer is told of the tools an earlier answer used: what was done, and the start of what came back. */
export function toolsForModel(tools: readonly ToolNote[] | undefined, resultChars = 500): string {
  if (!tools || tools.length === 0) return "";
  const lines = tools.slice(-12).map((t, i) => {
    const flat = t.result.replace(/\s+/g, " ").trim();
    const said = flat.length > resultChars ? `${flat.slice(0, resultChars - 1)}…` : flat;
    return `${i + 1}. ${t.name}: ${t.summary}${t.isError ? " (failed)" : ""}${said ? ` -> ${said}` : ""}`;
  });
  return `\n\n(What you did for this answer with your tools, for your own reference:\n${lines.join("\n")})`;
}

/** One line that says what a tool was called with. Nothing that signs in is in it. */
export function callLine(name: string, args: Record<string, unknown>): string {
  if (name === "keep_access") {
    const kind = typeof args.kind === "string" ? args.kind : "";
    const where =
      kind === "server"
        ? `${typeof args.username === "string" && args.username ? args.username : "root"}@${typeof args.host === "string" ? args.host : ""}`
        : kind === "site"
          ? `${typeof args.username === "string" ? args.username : ""} at ${typeof args.url === "string" ? args.url : ""}`
          : typeof args.label === "string"
            ? args.label
            : "a key";
    return `${kind} ${where}`.trim().slice(0, 140);
  }
  if (name === "use_browser") return callSummary(args).slice(0, 140);
  const first = ["command", "url", "path", "query", "note", "action"]
    .map((key) => args[key])
    .find((value): value is string => typeof value === "string" && value.length > 0);
  const server = typeof args.server === "string" && args.server ? `${args.server}: ` : "";
  const method = name === "http_request" && typeof args.method === "string" ? `${args.method.toUpperCase()} ` : "";
  const line = `${server}${method}${first ?? ""}`.replace(/\s+/g, " ").trim();
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}
