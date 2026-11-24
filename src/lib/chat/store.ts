import "server-only";
import { and, asc, count, desc, eq, inArray, sql, isNull } from "drizzle-orm";
import { db } from "@/db";
import { chatMessages, chats, type Chat, type ChatLine } from "@/db/schema";
import type { ChatMessage } from "../adapters/types";
import { keptForModel } from "../access/rules";
import { withoutSecrets } from "../access/store";
import { Errors } from "../errors";
import { CHATS_KEPT, CHAT_TITLE_MAX, HISTORY_CHARS, HISTORY_MESSAGES, titleFrom, toolsForModel, type MessageDetails } from "./rules";

/**
 * The conversations of the Chat page, as they are kept. A conversation
 * belongs to one account: every function here takes the account and finds
 * nothing of anyone else's.
 */

export interface ChatSummary {
  id: string;
  title: string;
  messages: number;
  /** Pinned by its account: it stays on top of the list. */
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface MessageDTO {
  id: number;
  role: "user" | "assistant";
  content: string;
  details: MessageDetails | null;
  promptTokens: number | null;
  completionTokens: number | null;
  createdAt: number;
}

function detailsOf(row: Pick<ChatLine, "details">): MessageDetails | null {
  if (!row.details) return null;
  try {
    const parsed: unknown = JSON.parse(row.details);
    return parsed && typeof parsed === "object" ? (parsed as MessageDetails) : null;
  } catch {
    return null;
  }
}

export function serializeMessage(row: ChatLine): MessageDTO {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    details: detailsOf(row),
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    createdAt: row.createdAt.getTime(),
  };
}

export function listChats(userId: string, limit = 100): ChatSummary[] {
  const rows = db.select().from(chats).where(eq(chats.userId, userId)).orderBy(desc(chats.updatedAt)).limit(limit).all();
  if (rows.length === 0) return [];
  const counts = new Map(
    db
      .select({ chatId: chatMessages.chatId, n: count() })
      .from(chatMessages)
      .where(inArray(chatMessages.chatId, rows.map((r) => r.id)))
      .groupBy(chatMessages.chatId)
      .all()
      .map((r) => [r.chatId, r.n] as const),
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    messages: counts.get(row.id) ?? 0,
    pinned: row.pinnedAt !== null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  }));
}

/** A conversation of this account, or a 404: the same answer for one that is not there and one that is someone else's. */
export function loadChat(userId: string, id: string): Chat {
  const row = db.select().from(chats).where(and(eq(chats.id, id), eq(chats.userId, userId))).get();
  if (!row) throw Errors.notFound("Conversation not found");
  return row;
}

export function messagesOf(chatId: string): MessageDTO[] {
  return db.select().from(chatMessages).where(eq(chatMessages.chatId, chatId)).orderBy(asc(chatMessages.id)).all().map(serializeMessage);
}

export function createChat(userId: string, opts: { title?: string; modelRowId?: string | null; systemPrompt?: string | null } = {}): Chat {
  const row = db
    .insert(chats)
    .values({ userId, title: (opts.title ?? "New chat").slice(0, CHAT_TITLE_MAX), modelRowId: opts.modelRowId ?? null, systemPrompt: opts.systemPrompt ?? null })
    .returning()
    .get();
  // Beyond the number kept, the conversations that were written in longest ago make way.
  // A pinned one stays.
  const old = db
    .select({ id: chats.id })
    .from(chats)
    .where(and(eq(chats.userId, userId), isNull(chats.pinnedAt)))
    .orderBy(desc(chats.updatedAt))
    .limit(1000)
    .offset(CHATS_KEPT)
    .all();
  if (old.length > 0) db.delete(chats).where(inArray(chats.id, old.map((r) => r.id))).run();
  return row;
}

export function renameChat(userId: string, id: string, title: string): Chat {
  const chat = loadChat(userId, id);
  const clean = title.replace(/\s+/g, " ").trim().slice(0, CHAT_TITLE_MAX);
  if (!clean) throw Errors.badRequest("Enter a name for the conversation.");
  db.update(chats).set({ title: clean }).where(eq(chats.id, chat.id)).run();
  return { ...chat, title: clean };
}

/** Pin a conversation to the top of its account's list, or let it go again. Its place among the others does not change. */
export function pinChat(userId: string, id: string, pinned: boolean): Chat {
  const chat = loadChat(userId, id);
  const pinnedAt = pinned ? (chat.pinnedAt ?? new Date()) : null;
  db.update(chats).set({ pinnedAt }).where(eq(chats.id, chat.id)).run();
  return { ...chat, pinnedAt };
}

export function deleteChat(userId: string, id: string): void {
  const chat = loadChat(userId, id);
  db.delete(chats).where(eq(chats.id, chat.id)).run();
}

export function deleteAllChats(userId: string): number {
  return db.delete(chats).where(eq(chats.userId, userId)).run().changes;
}

export function addMessage(
  chat: Pick<Chat, "id">,
  role: "user" | "assistant",
  content: string,
  details: MessageDetails | null = null,
  tokens: { prompt?: number; completion?: number } = {},
): MessageDTO {
  const row = db
    .insert(chatMessages)
    .values({
      chatId: chat.id,
      role,
      content,
      details: details && Object.keys(details).length > 0 ? JSON.stringify(details) : null,
      promptTokens: tokens.prompt ?? null,
      completionTokens: tokens.completion ?? null,
    })
    .returning()
    .get();
  db.update(chats).set({ updatedAt: new Date() }).where(eq(chats.id, chat.id)).run();
  return serializeMessage(row);
}

/** Name a conversation after its first message, when nobody has named it. */
export function nameFromFirst(chat: Chat, text: string): string {
  if (chat.title !== "New chat") return chat.title;
  const title = titleFrom(text);
  if (title !== chat.title) db.update(chats).set({ title }).where(eq(chats.id, chat.id)).run();
  return title;
}

export function setChatSetup(chatId: string, setup: { modelRowId?: string | null; systemPrompt?: string | null }): void {
  db.update(chats).set(setup).where(eq(chats.id, chatId)).run();
}

/**
 * Take secrets out of a conversation as it is stored: what the assistant
 * kept with its tool stood in a message in plain text until then.
 */
export function scrubChat(chatId: string, secrets: readonly string[]): void {
  const real = secrets.filter((s) => s.length >= 4);
  if (real.length === 0) return;
  const rows = db.select({ id: chatMessages.id, content: chatMessages.content, details: chatMessages.details }).from(chatMessages).where(eq(chatMessages.chatId, chatId)).all();
  for (const row of rows) {
    const content = withoutSecrets(row.content, real);
    const details = row.details ? withoutSecrets(row.details, real.map((s) => JSON.stringify(s).slice(1, -1))) : row.details;
    if (content !== row.content || details !== row.details) {
      db.update(chatMessages).set({ content, details }).where(eq(chatMessages.id, row.id)).run();
    }
  }
}

/**
 * The conversation as a model is shown it: the newest messages, each with
 * what the app notes about it. A message says what was taken out of it; an
 * answer says what its tools did, so that the next answer can go on from
 * there.
 */
export function historyFor(chatId: string): ChatMessage[] {
  const rows = db.select().from(chatMessages).where(eq(chatMessages.chatId, chatId)).orderBy(desc(chatMessages.id)).limit(HISTORY_MESSAGES).all();
  const out: ChatMessage[] = [];
  let chars = 0;
  let withTools = 0;
  for (const row of rows) {
    const details = detailsOf(row);
    let content = row.content;
    if (row.role === "user") content += keptForModel(details?.kept ?? []);
    else if (details?.tools?.length && withTools < 3) {
      withTools++;
      content += toolsForModel(details.tools);
    }
    if (!content.trim()) continue;
    chars += content.length;
    if (out.length > 0 && chars > HISTORY_CHARS) break;
    out.push({ role: row.role, content });
  }
  out.reverse();
  // A conversation as a model takes it starts with what the person said.
  while (out.length > 0 && out[0]!.role !== "user") out.shift();
  return out;
}

/** How many conversations an account has. */
export function chatCount(userId: string): number {
  return db.select({ n: sql<number>`count(*)` }).from(chats).where(eq(chats.userId, userId)).get()?.n ?? 0;
}
