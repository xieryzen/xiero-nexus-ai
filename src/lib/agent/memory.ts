import "server-only";
import { and, count, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentMemories, users, type AgentMemory } from "@/db/schema";
import { ftsQuery } from "../knowledge/chunk";

/**
 * Agent memory: short notes an agent chose to keep, which it gets back in
 * later tasks, in any project of the same person.
 *
 * Agents are shared by everyone on the server, so a note belongs to the agent
 * and to the user whose project it was written in: what an agent learned in
 * one person's project is never shown to it in another person's. Notes an
 * administrator adds by hand belong to nobody and apply to everyone.
 */

export const MAX_NOTE_CHARS = 1000;
/** Notes kept per agent and user; the least recently used go first. */
export const MAX_NOTES_PER_OWNER = 300;

export interface MemoryDTO {
  id: number;
  content: string;
  source: "agent" | "manual";
  projectId: string | null;
  /** Whose notes these are. Null for a note that applies to everyone. */
  owner: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

function normalize(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_CHARS);
}

/** The notes an agent may see when it works for this user. */
function visibleTo(agentId: string, userId: string | null) {
  return and(
    eq(agentMemories.agentId, agentId),
    userId
      ? or(eq(agentMemories.createdBy, userId), eq(agentMemories.source, "manual"))
      : eq(agentMemories.source, "manual"),
  );
}

/**
 * Keep a note. Returns the stored note and whether it is new: the same text
 * is not stored twice for the same person.
 */
export function rememberNote(
  agentId: string,
  content: string,
  opts: { projectId?: string | null; userId?: string | null; source?: "agent" | "manual" } = {},
): { memory: AgentMemory; created: boolean } | null {
  const text = normalize(content);
  if (!text) return null;
  const source = opts.source ?? "agent";
  // A note written by hand applies to everyone and has no owner.
  const owner = source === "manual" ? null : (opts.userId ?? null);
  const sameOwner = owner ? eq(agentMemories.createdBy, owner) : isNull(agentMemories.createdBy);
  const existing = db
    .select()
    .from(agentMemories)
    .where(and(eq(agentMemories.agentId, agentId), eq(agentMemories.content, text), sameOwner))
    .get();
  if (existing) return { memory: existing, created: false };

  const memory = db
    .insert(agentMemories)
    .values({ agentId, content: text, projectId: opts.projectId ?? null, createdBy: owner, source })
    .returning()
    .get();

  // Beyond the limit, the notes that were neither written nor used lately go.
  const total = db
    .select({ n: count() })
    .from(agentMemories)
    .where(and(eq(agentMemories.agentId, agentId), sameOwner))
    .get();
  const excess = (total?.n ?? 0) - MAX_NOTES_PER_OWNER;
  if (excess > 0) {
    const oldest = db
      .select({ id: agentMemories.id })
      .from(agentMemories)
      .where(and(eq(agentMemories.agentId, agentId), sameOwner))
      .orderBy(sql`coalesce(${agentMemories.lastUsedAt}, ${agentMemories.createdAt}) ASC`)
      .limit(excess)
      .all();
    if (oldest.length > 0) {
      db.delete(agentMemories)
        .where(
          inArray(
            agentMemories.id,
            oldest.map((o) => o.id),
          ),
        )
        .run();
    }
  }
  return { memory, created: true };
}

function touch(ids: number[]): void {
  if (ids.length === 0) return;
  db.update(agentMemories).set({ lastUsedAt: new Date() }).where(inArray(agentMemories.id, ids)).run();
}

/** The notes that fit a question best, most relevant first. */
export function searchNotes(
  agentId: string,
  userId: string | null,
  question: string,
  limit = 5,
): AgentMemory[] {
  const query = ftsQuery(question);
  if (!query) return [];
  let ids: number[] = [];
  try {
    ids = db
      .all<{ id: number }>(
        sql`SELECT m.id AS id
            FROM agent_memories_fts
            JOIN agent_memories m ON m.id = agent_memories_fts.rowid
            WHERE agent_memories_fts MATCH ${query}
              AND m.agent_id = ${agentId}
              AND (m.source = 'manual' OR m.created_by = ${userId ?? ""})
            ORDER BY bm25(agent_memories_fts)
            LIMIT ${limit}`,
      )
      .map((row) => row.id);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[xiero-nexus] memory search failed:", err);
    return [];
  }
  if (ids.length === 0) return [];
  const rows = db.select().from(agentMemories).where(inArray(agentMemories.id, ids)).all();
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  return ids.map((id) => byId.get(id)).filter((m): m is AgentMemory => Boolean(m));
}

/**
 * The notes to put in front of an agent for a task: those that fit the task,
 * filled up with the newest ones. Marks them as used.
 */
export function notesForTask(
  agentId: string,
  userId: string | null,
  task: string,
  limit = 6,
): AgentMemory[] {
  const relevant = searchNotes(agentId, userId, task, limit);
  const have = new Set(relevant.map((m) => m.id));
  const recent =
    relevant.length >= limit
      ? []
      : db
          .select()
          .from(agentMemories)
          .where(visibleTo(agentId, userId))
          .orderBy(desc(agentMemories.createdAt), desc(agentMemories.id))
          .limit(limit)
          .all()
          .filter((m) => !have.has(m.id))
          .slice(0, limit - relevant.length);
  const notes = [...relevant, ...recent];
  touch(notes.map((m) => m.id));
  return notes;
}

/** Search an agent's notes, for the `recall` tool. Marks what it returns as used. */
export function recallNotes(
  agentId: string,
  userId: string | null,
  question: string,
  limit = 8,
): AgentMemory[] {
  const notes = searchNotes(agentId, userId, question, limit);
  touch(notes.map((m) => m.id));
  return notes;
}

/**
 * An agent's notes, newest first: a user's own and the ones that apply to
 * everyone, or everybody's for an administrator (`userId` left out).
 */
export function listMemories(agentId: string, userId?: string, limit = 300): MemoryDTO[] {
  return db
    .select({ memory: agentMemories, owner: users.username })
    .from(agentMemories)
    .leftJoin(users, eq(agentMemories.createdBy, users.id))
    .where(userId ? visibleTo(agentId, userId) : eq(agentMemories.agentId, agentId))
    .orderBy(desc(agentMemories.createdAt), desc(agentMemories.id))
    .limit(limit)
    .all()
    .map(({ memory: m, owner }) => ({
      id: m.id,
      content: m.content,
      source: m.source,
      projectId: m.projectId,
      owner: m.source === "manual" ? null : (owner ?? "a deleted user"),
      createdAt: m.createdAt.getTime(),
      lastUsedAt: m.lastUsedAt ? m.lastUsedAt.getTime() : null,
    }));
}

/** How many notes each agent has, that this user may see (all, without a user). */
export function memoryCounts(userId?: string): Map<string, number> {
  const rows = db
    .select({ agentId: agentMemories.agentId, n: count() })
    .from(agentMemories)
    .where(
      userId ? or(eq(agentMemories.createdBy, userId), eq(agentMemories.source, "manual")) : undefined,
    )
    .groupBy(agentMemories.agentId)
    .all();
  return new Map(rows.map((r) => [r.agentId, r.n] as const));
}

/**
 * Delete a note. A user may delete their own; only an administrator
 * (`userId` left out) one that applies to everyone or is someone else's.
 */
export function deleteMemory(agentId: string, id: number, userId?: string): boolean {
  const result = db
    .delete(agentMemories)
    .where(
      and(
        eq(agentMemories.agentId, agentId),
        eq(agentMemories.id, id),
        userId ? eq(agentMemories.createdBy, userId) : undefined,
      ),
    )
    .run();
  return result.changes > 0;
}

/** Delete an agent's notes: one user's own, or all of them (`userId` left out). */
export function clearMemories(agentId: string, userId?: string): number {
  return db
    .delete(agentMemories)
    .where(and(eq(agentMemories.agentId, agentId), userId ? eq(agentMemories.createdBy, userId) : undefined))
    .run().changes;
}
