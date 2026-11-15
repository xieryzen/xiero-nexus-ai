import "server-only";
import { and, count, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { apiKeys, usageRecords, users, type ApiKey, type User } from "@/db/schema";
import { randomToken, sha256 } from "./crypto";
import { AppError, Errors } from "./errors";
import { rateLimit } from "./ratelimit";
import { API_SCOPES, type ApiScope } from "./validation";

/**
 * API keys for the public API (/api/v1). A key acts as the user who made it,
 * within the scopes, models and limits it was given. Only a hash of the key
 * is stored: the key itself is shown once, when it is created.
 */

export const API_KEY_PREFIX = "xn_";
export const MAX_KEYS_PER_USER = 20;
/** Requests per minute for a key without a limit of its own. */
export const DEFAULT_KEY_RATE_LIMIT = 120;

export interface ApiKeyDTO {
  id: string;
  name: string;
  /** The first characters of the key, for telling keys apart. */
  prefix: string;
  scopes: ApiScope[];
  modelRowIds: string[] | null;
  rateLimitPerMinute: number | null;
  monthlyTokenLimit: number | null;
  monthlyCostLimit: number | null;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
  createdAt: number;
  /** Tokens and estimated cost since the start of this month (UTC). */
  monthTokens: number;
  monthCost: number;
}

function parseList(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : null;
  } catch {
    return null;
  }
}

export function scopesOf(key: ApiKey): ApiScope[] {
  return (parseList(key.scopes) ?? []).filter((s): s is ApiScope =>
    (API_SCOPES as readonly string[]).includes(s),
  );
}

function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** What a key has used since the start of the month. */
export function monthUsage(keyId: string): { tokens: number; cost: number } {
  const row = db
    .select({
      tokens: sql<number>`coalesce(sum(${usageRecords.totalTokens}), 0)`,
      cost: sql<number>`coalesce(sum(${usageRecords.estimatedCost}), 0)`,
    })
    .from(usageRecords)
    .where(and(eq(usageRecords.apiKeyId, keyId), gte(usageRecords.createdAt, monthStart())))
    .get();
  return { tokens: Number(row?.tokens ?? 0), cost: Number(row?.cost ?? 0) };
}

export function serializeApiKey(key: ApiKey): ApiKeyDTO {
  const used = monthUsage(key.id);
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    scopes: scopesOf(key),
    modelRowIds: parseList(key.modelRowIds),
    rateLimitPerMinute: key.rateLimitPerMinute,
    monthlyTokenLimit: key.monthlyTokenLimit,
    monthlyCostLimit: key.monthlyCostLimit,
    expiresAt: key.expiresAt ? key.expiresAt.getTime() : null,
    lastUsedAt: key.lastUsedAt ? key.lastUsedAt.getTime() : null,
    revokedAt: key.revokedAt ? key.revokedAt.getTime() : null,
    createdAt: key.createdAt.getTime(),
    monthTokens: used.tokens,
    monthCost: used.cost,
  };
}

export function listApiKeys(userId: string): ApiKey[] {
  return db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .orderBy(desc(apiKeys.createdAt))
    .all();
}

export interface CreateApiKeyInput {
  name: string;
  scopes: ApiScope[];
  modelRowIds?: string[] | null;
  rateLimitPerMinute?: number | null;
  monthlyTokenLimit?: number | null;
  monthlyCostLimit?: number | null;
  expiresInDays?: number | null;
}

/** Make a key. `secret` is the key itself: it cannot be read again later. */
export function createApiKey(userId: string, input: CreateApiKeyInput): { key: ApiKey; secret: string } {
  const active = db
    .select({ n: count() })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
    .get();
  if ((active?.n ?? 0) >= MAX_KEYS_PER_USER) {
    throw Errors.badRequest(`You can have ${MAX_KEYS_PER_USER} keys. Revoke one you no longer use.`);
  }
  const secret = `${API_KEY_PREFIX}${randomToken(32)}`;
  const key = db
    .insert(apiKeys)
    .values({
      userId,
      name: input.name,
      prefix: secret.slice(0, 10),
      keyHash: sha256(secret),
      scopes: JSON.stringify([...new Set(input.scopes)]),
      modelRowIds: input.modelRowIds?.length ? JSON.stringify([...new Set(input.modelRowIds)]) : null,
      rateLimitPerMinute: input.rateLimitPerMinute ?? null,
      monthlyTokenLimit: input.monthlyTokenLimit ?? null,
      monthlyCostLimit: input.monthlyCostLimit ?? null,
      expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
    })
    .returning()
    .get();
  return { key, secret };
}

/** Revoke a user's key. It stops working at once. Returns false when it is not theirs. */
export function revokeApiKey(userId: string, keyId: string): ApiKey | null {
  return (
    db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
      .returning()
      .get() ?? null
  );
}

export interface ApiCaller {
  key: ApiKey;
  user: User;
}

function unauthorized(message: string): AppError {
  return new AppError(401, "invalid_api_key", message);
}

/**
 * The key a request came in with, and its user. Throws 401 for a missing,
 * unknown, revoked or expired key, and for a user who can no longer sign in.
 */
export function authenticateApiKey(req: Request): ApiCaller {
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(\S+)$/i);
  const secret = match?.[1] ?? req.headers.get("x-api-key")?.trim() ?? "";
  if (!secret) {
    throw unauthorized("Send your API key in the Authorization header: Bearer xn_…");
  }
  if (!secret.startsWith(API_KEY_PREFIX)) throw unauthorized("That is not an API key of this server");
  // The key is long and random, so its hash is looked up directly.
  const key = db.select().from(apiKeys).where(eq(apiKeys.keyHash, sha256(secret))).get();
  if (!key || key.revokedAt) throw unauthorized("This API key does not exist or was revoked");
  if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) throw unauthorized("This API key has expired");
  const user = db.select().from(users).where(eq(users.id, key.userId)).get();
  if (!user || user.status !== "active") throw unauthorized("The account of this API key is disabled");

  // Written at most once a minute: it is for the key list, not for accounting.
  if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > 60_000) {
    db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, key.id)).run();
  }
  return { key, user };
}

export function requireScope(key: ApiKey, scope: ApiScope): void {
  if (!scopesOf(key).includes(scope)) {
    throw new AppError(403, "insufficient_scope", `This API key is not allowed to use "${scope}"`);
  }
}

/** Throws 429 when the key is over its rate limit or its monthly limits. */
export function checkKeyLimits(key: ApiKey): void {
  const perMinute = key.rateLimitPerMinute ?? DEFAULT_KEY_RATE_LIMIT;
  const rate = rateLimit(`apikey:${key.id}`, perMinute, 60_000);
  if (!rate.ok) {
    throw new AppError(
      429,
      "rate_limit_exceeded",
      `This API key is limited to ${perMinute} requests a minute. Try again in ${Math.ceil(rate.retryAfterMs / 1000)} seconds.`,
    );
  }
  if (key.monthlyTokenLimit === null && key.monthlyCostLimit === null) return;
  const used = monthUsage(key.id);
  if (key.monthlyTokenLimit !== null && used.tokens >= key.monthlyTokenLimit) {
    throw new AppError(429, "quota_exceeded", "This API key has used up its token limit for this month");
  }
  if (key.monthlyCostLimit !== null && used.cost >= key.monthlyCostLimit) {
    throw new AppError(429, "quota_exceeded", "This API key has used up its cost limit for this month");
  }
}

/** Throws 403 when the key may not use this model. */
export function assertKeyAllowsModel(key: ApiKey, modelRowId: string): void {
  const allowed = parseList(key.modelRowIds);
  if (allowed && !allowed.includes(modelRowId)) {
    throw new AppError(403, "model_not_allowed", "This API key is not allowed to use that model");
  }
}

/** The models a key may use: null for every model. */
export function keyModelIds(key: ApiKey): string[] | null {
  return parseList(key.modelRowIds);
}
