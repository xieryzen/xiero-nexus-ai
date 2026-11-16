import "server-only";
import { and, asc, count, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  agentKnowledge,
  jobs,
  knowledgeChunks,
  knowledgeCollections,
  knowledgeDocuments,
  models,
  type KnowledgeCollection,
  type KnowledgeDocument,
  type User,
} from "@/db/schema";
import { AppError, Errors, sanitizeUpstreamError } from "../errors";
import { gatewayEmbed, resolveEmbeddingModel } from "../gateway";
import { computeCost, estimateTokens, recordUsage } from "../usage";
import {
  bytesToVector,
  chunkText,
  cosineSimilarity,
  ftsQuery,
  fuseRankings,
  vectorToBytes,
} from "./chunk";
import { isAdminRole } from "@/lib/roles";

/**
 * The knowledge base: collections of documents that agents and the chat can
 * look things up in.
 *
 * A document is cut into passages. Every passage is indexed for full-text
 * search (SQLite FTS5) as soon as it is added, so a collection can be searched
 * at once and without any model. When the collection has an embedding model,
 * the passages are also embedded, in the background, and a search then
 * combines both rankings: the words of the question and its meaning.
 */

export const MAX_DOCUMENTS_PER_COLLECTION = 500;
/** Passages a collection may hold. Search by meaning compares with each one. */
export const MAX_CHUNKS_PER_COLLECTION = 20_000;
const EMBED_BATCH = 32;
/** Candidates taken from each ranking before they are merged. */
const CANDIDATES = 40;
/** Vectors read from the database at a time when searching by meaning. */
const VECTOR_PAGE = 2000;

// ─── Access ──────────────────────────────────────────────────────────────────

export function canManageCollection(collection: KnowledgeCollection, user: User): boolean {
  return isAdminRole(user.role) || collection.createdBy === user.id;
}

export function canReadCollection(collection: KnowledgeCollection, user: User): boolean {
  return collection.visibility === "shared" || canManageCollection(collection, user);
}

function loadCollection(id: string): KnowledgeCollection {
  const collection = db
    .select()
    .from(knowledgeCollections)
    .where(eq(knowledgeCollections.id, id))
    .get();
  if (!collection) throw Errors.notFound("Collection not found");
  return collection;
}

export function loadReadableCollection(id: string, user: User): KnowledgeCollection {
  const collection = loadCollection(id);
  // Not found rather than forbidden: a private collection's existence is not disclosed.
  if (!canReadCollection(collection, user)) throw Errors.notFound("Collection not found");
  return collection;
}

export function loadManagedCollection(id: string, user: User): KnowledgeCollection {
  const collection = loadReadableCollection(id, user);
  if (!canManageCollection(collection, user)) throw Errors.forbidden();
  return collection;
}

/** The ids among `ids` that a user may search. */
export function readableCollectionIds(ids: string[], user: User): string[] {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(knowledgeCollections)
    .where(inArray(knowledgeCollections.id, [...new Set(ids)]))
    .all()
    .filter((c) => canReadCollection(c, user))
    .map((c) => c.id);
}

// ─── Collections ─────────────────────────────────────────────────────────────

export interface CollectionDTO {
  id: string;
  name: string;
  description: string | null;
  visibility: "private" | "shared";
  embeddingModelRowId: string | null;
  embeddingModelLabel: string | null;
  documentCount: number;
  chunkCount: number;
  owner: boolean;
  canManage: boolean;
  createdAt: number;
  updatedAt: number;
}

export function serializeCollection(collection: KnowledgeCollection, user: User): CollectionDTO {
  const docs = db
    .select({ n: count(), chunks: sql<number>`coalesce(sum(${knowledgeDocuments.chunkCount}), 0)` })
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.collectionId, collection.id))
    .get();
  const model = collection.embeddingModelRowId
    ? db
        .select({ modelId: models.modelId, displayName: models.displayName })
        .from(models)
        .where(eq(models.id, collection.embeddingModelRowId))
        .get()
    : undefined;
  return {
    id: collection.id,
    name: collection.name,
    description: collection.description,
    visibility: collection.visibility,
    embeddingModelRowId: collection.embeddingModelRowId,
    embeddingModelLabel: model ? model.displayName || model.modelId : null,
    documentCount: docs?.n ?? 0,
    chunkCount: Number(docs?.chunks ?? 0),
    owner: collection.createdBy === user.id,
    canManage: canManageCollection(collection, user),
    createdAt: collection.createdAt.getTime(),
    updatedAt: collection.updatedAt.getTime(),
  };
}

/** The collections a user can read: their own and the shared ones (all, for an administrator). */
export function listCollections(user: User): CollectionDTO[] {
  const rows = db
    .select()
    .from(knowledgeCollections)
    .where(
      isAdminRole(user.role)
        ? undefined
        : or(eq(knowledgeCollections.createdBy, user.id), eq(knowledgeCollections.visibility, "shared")),
    )
    .orderBy(asc(knowledgeCollections.name))
    .all();
  return rows.map((c) => serializeCollection(c, user));
}

/** Shared collections, the ones an agent can be given. */
export function sharedCollections(): { id: string; name: string }[] {
  return db
    .select({ id: knowledgeCollections.id, name: knowledgeCollections.name })
    .from(knowledgeCollections)
    .where(eq(knowledgeCollections.visibility, "shared"))
    .orderBy(asc(knowledgeCollections.name))
    .all();
}

function checkEmbeddingModel(modelRowId: string | null | undefined): void {
  if (!modelRowId) return;
  try {
    resolveEmbeddingModel(modelRowId);
  } catch (err) {
    throw Errors.badRequest(`Embedding model: ${err instanceof AppError ? err.message : "not usable"}`);
  }
}

export function createCollection(
  user: User,
  input: {
    name: string;
    description?: string | null;
    visibility?: "private" | "shared";
    embeddingModelRowId?: string | null;
  },
): KnowledgeCollection {
  checkEmbeddingModel(input.embeddingModelRowId);
  return db
    .insert(knowledgeCollections)
    .values({
      name: input.name,
      description: input.description || null,
      visibility: input.visibility ?? "private",
      embeddingModelRowId: input.embeddingModelRowId ?? null,
      createdBy: user.id,
    })
    .returning()
    .get();
}

export function updateCollection(
  collection: KnowledgeCollection,
  input: {
    name?: string;
    description?: string | null;
    visibility?: "private" | "shared";
    embeddingModelRowId?: string | null;
  },
): KnowledgeCollection {
  const modelChanged =
    input.embeddingModelRowId !== undefined &&
    (input.embeddingModelRowId ?? null) !== collection.embeddingModelRowId;
  if (modelChanged) checkEmbeddingModel(input.embeddingModelRowId);

  // A collection that agents use has to stay shared.
  if (input.visibility === "private" && collection.visibility === "shared") {
    const used = db
      .select({ n: count() })
      .from(agentKnowledge)
      .where(eq(agentKnowledge.collectionId, collection.id))
      .get();
    if ((used?.n ?? 0) > 0) {
      throw Errors.badRequest(
        "This collection is given to one or more agents. Remove it from them before making it private.",
      );
    }
  }

  const updated = db
    .update(knowledgeCollections)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description || null } : {}),
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      ...(input.embeddingModelRowId !== undefined
        ? { embeddingModelRowId: input.embeddingModelRowId ?? null }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(knowledgeCollections.id, collection.id))
    .returning()
    .get();

  if (modelChanged) {
    // Vectors of another model cannot be compared with the new one's.
    db.update(knowledgeChunks)
      .set({ embedding: null, embeddingModelRowId: null })
      .where(eq(knowledgeChunks.collectionId, collection.id))
      .run();
    const status = updated.embeddingModelRowId ? "pending" : "none";
    const docs = db
      .update(knowledgeDocuments)
      .set({ embeddingStatus: status, error: null, updatedAt: new Date() })
      .where(eq(knowledgeDocuments.collectionId, collection.id))
      .returning({ id: knowledgeDocuments.id })
      .all();
    if (status === "pending") for (const doc of docs) queueEmbedding(doc.id, null);
  }
  return updated;
}

export function deleteCollection(collection: KnowledgeCollection): void {
  db.delete(knowledgeCollections).where(eq(knowledgeCollections.id, collection.id)).run();
}

// ─── Documents ───────────────────────────────────────────────────────────────

export interface DocumentDTO {
  id: string;
  title: string;
  sourceType: "upload" | "text" | "url";
  sourceName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  charCount: number;
  chunkCount: number;
  embeddingStatus: "none" | "pending" | "ready" | "failed";
  error: string | null;
  createdAt: number;
}

export function serializeDocument(doc: KnowledgeDocument): DocumentDTO {
  return {
    id: doc.id,
    title: doc.title,
    sourceType: doc.sourceType,
    sourceName: doc.sourceName,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    charCount: doc.charCount,
    chunkCount: doc.chunkCount,
    embeddingStatus: doc.embeddingStatus,
    error: doc.error,
    createdAt: doc.createdAt.getTime(),
  };
}

export function listDocuments(collectionId: string): DocumentDTO[] {
  return db
    .select()
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.collectionId, collectionId))
    .orderBy(desc(knowledgeDocuments.createdAt), desc(knowledgeDocuments.id))
    .all()
    .map(serializeDocument);
}

function queueEmbedding(documentId: string, userId: string | null): void {
  db.insert(jobs)
    .values({ kind: "embed", payload: JSON.stringify({ documentId }), userId })
    .run();
}

export interface AddDocumentInput {
  title: string;
  sourceType: "upload" | "text" | "url";
  sourceName?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  text: string;
}

/** Add a document: cut it into passages and index them. Searchable when this returns. */
export function addDocument(
  collection: KnowledgeCollection,
  userId: string | null,
  input: AddDocumentInput,
): KnowledgeDocument {
  const chunks = chunkText(input.text);
  if (chunks.length === 0) throw Errors.badRequest("The document has no text");

  const totals = db
    .select({ n: count(), chunks: sql<number>`coalesce(sum(${knowledgeDocuments.chunkCount}), 0)` })
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.collectionId, collection.id))
    .get();
  if ((totals?.n ?? 0) >= MAX_DOCUMENTS_PER_COLLECTION) {
    throw Errors.badRequest(`A collection can hold ${MAX_DOCUMENTS_PER_COLLECTION} documents`);
  }
  if (Number(totals?.chunks ?? 0) + chunks.length > MAX_CHUNKS_PER_COLLECTION) {
    throw Errors.badRequest(
      "This collection is full. Remove documents from it, or put this one into another collection.",
    );
  }

  const embed = Boolean(collection.embeddingModelRowId);
  const doc = db.transaction((tx) => {
    const row = tx
      .insert(knowledgeDocuments)
      .values({
        collectionId: collection.id,
        title: input.title.slice(0, 200) || "Untitled",
        sourceType: input.sourceType,
        sourceName: input.sourceName?.slice(0, 500) ?? null,
        mimeType: input.mimeType ?? null,
        sizeBytes: input.sizeBytes ?? null,
        charCount: input.text.length,
        chunkCount: chunks.length,
        embeddingStatus: embed ? "pending" : "none",
        createdBy: userId,
      })
      .returning()
      .get();
    chunks.forEach((content, seq) => {
      tx.insert(knowledgeChunks)
        .values({ documentId: row.id, collectionId: collection.id, seq, content })
        .run();
    });
    tx.update(knowledgeCollections)
      .set({ updatedAt: new Date() })
      .where(eq(knowledgeCollections.id, collection.id))
      .run();
    return row;
  });
  if (embed) queueEmbedding(doc.id, userId);
  return doc;
}

export function deleteDocument(collection: KnowledgeCollection, documentId: string): void {
  const doc = db
    .select({ id: knowledgeDocuments.id })
    .from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.id, documentId), eq(knowledgeDocuments.collectionId, collection.id)))
    .get();
  if (!doc) throw Errors.notFound("Document not found");
  db.delete(knowledgeDocuments).where(eq(knowledgeDocuments.id, doc.id)).run();
  db.update(knowledgeCollections)
    .set({ updatedAt: new Date() })
    .where(eq(knowledgeCollections.id, collection.id))
    .run();
}

/**
 * Embed a document's passages. Called by the background worker. Returns
 * without doing anything when the document or its collection's embedding
 * model is gone.
 */
export async function embedDocument(documentId: string, userId: string | null): Promise<void> {
  const doc = db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, documentId)).get();
  if (!doc) return;
  const collection = db
    .select()
    .from(knowledgeCollections)
    .where(eq(knowledgeCollections.id, doc.collectionId))
    .get();
  const modelRowId = collection?.embeddingModelRowId;
  const setStatus = (embeddingStatus: KnowledgeDocument["embeddingStatus"], error: string | null) =>
    db
      .update(knowledgeDocuments)
      .set({ embeddingStatus, error, updatedAt: new Date() })
      .where(eq(knowledgeDocuments.id, documentId))
      .run();
  if (!modelRowId) {
    setStatus("none", null);
    return;
  }

  const started = Date.now();
  let providerId: string | null = null;
  try {
    const resolved = resolveEmbeddingModel(modelRowId);
    providerId = resolved.provider.id;
    for (;;) {
      const batch = db
        .select({ id: knowledgeChunks.id, content: knowledgeChunks.content })
        .from(knowledgeChunks)
        .where(
          and(
            eq(knowledgeChunks.documentId, documentId),
            or(isNull(knowledgeChunks.embedding), ne(knowledgeChunks.embeddingModelRowId, modelRowId)),
          ),
        )
        .orderBy(asc(knowledgeChunks.seq))
        .limit(EMBED_BATCH)
        .all();
      if (batch.length === 0) break;
      const texts = batch.map((c) => c.content);
      const result = await gatewayEmbed(resolved, texts);
      db.transaction((tx) => {
        batch.forEach((chunk, i) => {
          tx.update(knowledgeChunks)
            .set({
              embedding: Buffer.from(vectorToBytes(result.vectors[i]!)),
              embeddingModelRowId: modelRowId,
            })
            .where(eq(knowledgeChunks.id, chunk.id))
            .run();
        });
      });
      const tokens = result.promptTokens ?? estimateTokens(texts.join("\n"));
      recordUsage({
        userId,
        providerId,
        modelRowId,
        kind: "embedding",
        promptTokens: tokens,
        estimatedCost: computeCost(resolved.model, tokens, 0),
        status: "ok",
        latencyMs: Date.now() - started,
      });
    }
    setStatus("ready", null);
  } catch (err) {
    const message = err instanceof AppError ? err.message : sanitizeUpstreamError(err);
    recordUsage({
      userId,
      providerId,
      modelRowId,
      kind: "embedding",
      status: "error",
      errorCode: err instanceof AppError ? err.code : "error",
      latencyMs: Date.now() - started,
    });
    setStatus("failed", message);
    throw err instanceof AppError ? err : new AppError(502, "embed_failed", message);
  }
}

/** Queue the embedding of a document again, after it failed. */
export function retryEmbedding(collection: KnowledgeCollection, documentId: string, userId: string): void {
  if (!collection.embeddingModelRowId) {
    throw Errors.badRequest("This collection has no embedding model");
  }
  const doc = db
    .update(knowledgeDocuments)
    .set({ embeddingStatus: "pending", error: null, updatedAt: new Date() })
    .where(and(eq(knowledgeDocuments.id, documentId), eq(knowledgeDocuments.collectionId, collection.id)))
    .returning({ id: knowledgeDocuments.id })
    .get();
  if (!doc) throw Errors.notFound("Document not found");
  queueEmbedding(doc.id, userId);
}

// ─── Search ──────────────────────────────────────────────────────────────────

export interface KnowledgeHit {
  chunkId: number;
  documentId: string;
  documentTitle: string;
  collectionId: string;
  collectionName: string;
  seq: number;
  content: string;
  /** How it was found: by the question's words, by its meaning, or both. */
  matched: ("text" | "meaning")[];
}

function idList(ids: string[]) {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

function textRanking(collectionIds: string[], question: string): number[] {
  const query = ftsQuery(question);
  if (!query) return [];
  try {
    return db
      .all<{ id: number }>(
        sql`SELECT c.id AS id
            FROM knowledge_chunks_fts
            JOIN knowledge_chunks c ON c.id = knowledge_chunks_fts.rowid
            WHERE knowledge_chunks_fts MATCH ${query}
              AND c.collection_id IN (${idList(collectionIds)})
            ORDER BY bm25(knowledge_chunks_fts)
            LIMIT ${CANDIDATES}`,
      )
      .map((row) => row.id);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[xiero-nexus] knowledge text search failed:", err);
    return [];
  }
}

/** Rank by meaning, in each collection that has an embedding model. */
async function meaningRanking(
  collections: KnowledgeCollection[],
  question: string,
  userId: string | null,
): Promise<number[]> {
  const scored: { id: number; score: number }[] = [];
  // One question vector per embedding model, shared by the collections on it.
  const vectors = new Map<string, Float32Array | null>();
  for (const collection of collections) {
    const modelRowId = collection.embeddingModelRowId;
    if (!modelRowId) continue;
    if (!vectors.has(modelRowId)) {
      try {
        const resolved = resolveEmbeddingModel(modelRowId);
        const started = Date.now();
        const result = await gatewayEmbed(resolved, [question]);
        const tokens = result.promptTokens ?? estimateTokens(question);
        recordUsage({
          userId,
          providerId: resolved.provider.id,
          modelRowId,
          kind: "embedding",
          promptTokens: tokens,
          estimatedCost: computeCost(resolved.model, tokens, 0),
          status: "ok",
          latencyMs: Date.now() - started,
        });
        vectors.set(modelRowId, new Float32Array(result.vectors[0]!));
      } catch {
        // The embedding model is unavailable: the words of the question still work.
        vectors.set(modelRowId, null);
      }
    }
    const queryVector = vectors.get(modelRowId);
    if (!queryVector) continue;
    // Read in pages, so that a large collection is never in memory at once.
    let afterId = 0;
    for (;;) {
      const rows = db
        .select({ id: knowledgeChunks.id, embedding: knowledgeChunks.embedding })
        .from(knowledgeChunks)
        .where(
          and(
            eq(knowledgeChunks.collectionId, collection.id),
            eq(knowledgeChunks.embeddingModelRowId, modelRowId),
            gt(knowledgeChunks.id, afterId),
          ),
        )
        .orderBy(asc(knowledgeChunks.id))
        .limit(VECTOR_PAGE)
        .all();
      if (rows.length === 0) break;
      afterId = rows[rows.length - 1]!.id;
      for (const row of rows) {
        if (!row.embedding) continue;
        const vector = bytesToVector(row.embedding);
        if (vector.length !== queryVector.length) continue;
        scored.push({ id: row.id, score: cosineSimilarity(queryVector, vector) });
      }
      // Keep only the best so far.
      if (scored.length > CANDIDATES * 4) {
        scored.sort((a, b) => b.score - a.score);
        scored.length = CANDIDATES;
      }
    }
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, CANDIDATES)
    .map((s) => s.id);
}

/**
 * The passages of some collections that best answer a question. The caller
 * has already checked that these collections may be read.
 */
export async function searchKnowledge(
  collectionIds: string[],
  question: string,
  opts: { limit?: number; userId?: string | null } = {},
): Promise<KnowledgeHit[]> {
  const limit = Math.min(Math.max(1, opts.limit ?? 6), 20);
  const ids = [...new Set(collectionIds)];
  if (ids.length === 0 || !question.trim()) return [];
  const collections = db
    .select()
    .from(knowledgeCollections)
    .where(inArray(knowledgeCollections.id, ids))
    .all();
  if (collections.length === 0) return [];
  const found = collections.map((c) => c.id);

  const byText = textRanking(found, question);
  const byMeaning = await meaningRanking(collections, question.slice(0, 2000), opts.userId ?? null);
  const fused = fuseRankings([byText, byMeaning]).slice(0, limit);
  if (fused.length === 0) return [];

  const rows = db
    .select({
      chunkId: knowledgeChunks.id,
      documentId: knowledgeChunks.documentId,
      collectionId: knowledgeChunks.collectionId,
      seq: knowledgeChunks.seq,
      content: knowledgeChunks.content,
      documentTitle: knowledgeDocuments.title,
    })
    .from(knowledgeChunks)
    .innerJoin(knowledgeDocuments, eq(knowledgeChunks.documentId, knowledgeDocuments.id))
    .where(
      inArray(
        knowledgeChunks.id,
        fused.map((f) => f.id),
      ),
    )
    .all();
  const byId = new Map(rows.map((r) => [r.chunkId, r] as const));
  const names = new Map(collections.map((c) => [c.id, c.name] as const));
  const textSet = new Set(byText);
  const meaningSet = new Set(byMeaning);

  const hits: KnowledgeHit[] = [];
  for (const { id } of fused) {
    const row = byId.get(id);
    if (!row) continue;
    const matched: KnowledgeHit["matched"] = [];
    if (textSet.has(id)) matched.push("text");
    if (meaningSet.has(id)) matched.push("meaning");
    hits.push({ ...row, collectionName: names.get(row.collectionId) ?? "", matched });
  }
  return hits;
}

/** Passages as a block of text for a prompt, each with where it is from. */
export function formatHits(hits: KnowledgeHit[], maxChars = 9000): string {
  const parts: string[] = [];
  let used = 0;
  hits.forEach((hit, index) => {
    const block = `[${index + 1}] ${hit.documentTitle} (${hit.collectionName})\n${hit.content}`;
    if (used + block.length > maxChars && parts.length > 0) return;
    parts.push(block);
    used += block.length;
  });
  return parts.join("\n\n");
}

// ─── Agents ──────────────────────────────────────────────────────────────────

/** The collections an agent looks things up in. Only shared ones count. */
export function collectionIdsForAgent(agentId: string): string[] {
  return db
    .select({ id: knowledgeCollections.id })
    .from(agentKnowledge)
    .innerJoin(knowledgeCollections, eq(agentKnowledge.collectionId, knowledgeCollections.id))
    .where(and(eq(agentKnowledge.agentId, agentId), eq(knowledgeCollections.visibility, "shared")))
    .all()
    .map((r) => r.id);
}

/** Give an agent these collections and no others. Each must be shared. */
export function setAgentCollections(agentId: string, collectionIds: string[]): void {
  const ids = [...new Set(collectionIds)];
  if (ids.length > 0) {
    const shared = new Set(
      db
        .select({ id: knowledgeCollections.id })
        .from(knowledgeCollections)
        .where(and(inArray(knowledgeCollections.id, ids), eq(knowledgeCollections.visibility, "shared")))
        .all()
        .map((r) => r.id),
    );
    if (ids.some((id) => !shared.has(id))) {
      throw Errors.badRequest(
        "An agent can only be given shared collections. Make the collection shared on the Knowledge page first.",
      );
    }
  }
  db.transaction((tx) => {
    tx.delete(agentKnowledge).where(eq(agentKnowledge.agentId, agentId)).run();
    for (const collectionId of ids) {
      tx.insert(agentKnowledge).values({ agentId, collectionId }).run();
    }
  });
}

export function agentCollectionMap(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of db.select().from(agentKnowledge).all()) {
    const list = map.get(row.agentId) ?? [];
    list.push(row.collectionId);
    map.set(row.agentId, list);
  }
  return map;
}
