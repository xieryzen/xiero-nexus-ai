import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { modelCapabilities, models, providers, type Model, type Provider } from "@/db/schema";
import { adapterIsImplemented } from "./adapters";
import { audit } from "./audit";
import { isMediaOnly } from "./capabilities";
import { AppError, sanitizeUpstreamError } from "./errors";
import { gatewayChat } from "./gateway";
import { HEALTH_CHECK_TIMEOUT_MS, RETRY_AT_MAX_MS, USE_FAILURES_TO_HIDE, failureKind, healthIntervalMs, isDue, isFailing } from "./model-health-rules";
import { runtime } from "./runtime";
import { stopping } from "./shutdown";
import { limitOf } from "./upstream";
import { computeCost, estimateTokens, recordUsage } from "./usage";

/**
 * Checking that the models answer.
 *
 * A check asks a model for one word, as the Test button of the Models page
 * does. The background worker checks every model that is switched on: soon
 * after it was added, then every MODEL_HEALTH_INTERVAL_MINUTES (six hours when
 * nothing is set), and a model that failed sooner than that, so that it comes
 * back when it works again. What a result means is in model-health-rules.ts.
 *
 * Only models that answer in text are checked. Checking an image, video or
 * speech model would mean generating (and paying for) a picture, a clip or a
 * recording each time.
 */

const PROMPT = "Reply with the single word: ok";
/** Between two checks of a round, so that a provider is not asked in a burst. */
const PAUSE_MS = 1_000;
/** Most models one round asks; the rest is due in the next. */
const ROUND_MAX = 300;
/** How often the worker looks for models that are due. */
const LOOK_EVERY_MS = 15_000;

/** Before a model that worked is written down as failing for something temporary, it is asked once more after this long. */
function secondTryAfterMs(): number {
  const seconds = Number(process.env.MODEL_HEALTH_RETRY_SECONDS ?? "");
  return Number.isFinite(seconds) && seconds >= 0 && process.env.MODEL_HEALTH_RETRY_SECONDS ? Math.min(seconds, 300) * 1000 : 20_000;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type CheckOutcome =
  | { ok: true; sample: string; promptTokens: number; completionTokens: number; latencyMs: number }
  | { ok: false; error: string; code: string; kind: "refused" | "temporary"; latencyMs: number; /** The wait the provider named with a "not now". */ waitMs?: number | null };

/** Ask the model for one word. Nothing is written down. */
export async function askModel(model: Model, provider: Provider): Promise<CheckOutcome> {
  const started = Date.now();
  try {
    const result = await gatewayChat(
      { model, provider: { ...provider, timeoutMs: Math.min(provider.timeoutMs, HEALTH_CHECK_TIMEOUT_MS) } },
      [{ role: "user", content: PROMPT }],
      // The check writes its own result (recordOutcome).
      { temperature: 0, unnoted: true },
    );
    return {
      ok: true,
      sample: result.content,
      promptTokens: result.usage?.promptTokens ?? estimateTokens(PROMPT),
      completionTokens: result.usage?.completionTokens ?? estimateTokens(result.content),
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    const error = err instanceof AppError ? err.message : sanitizeUpstreamError(err);
    const code = err instanceof AppError ? err.code : "error";
    return { ok: false, error, code, kind: failureKind({ code, message: error }), latencyMs: Date.now() - started, waitMs: limitOf(err)?.waitMs ?? null };
  }
}

/** Write the result of a check down: on the model, and as usage. `userId` is who asked for it; null for the automatic check. */
export function recordOutcome(model: Model, provider: Provider, outcome: CheckOutcome, userId: string | null): void {
  const usage = { userId, providerId: provider.id, modelRowId: model.id, kind: "test" as const, latencyMs: outcome.latencyMs };
  // Outside a request there is no API key to count it for.
  const apiKeyId = userId ? undefined : null;
  if (outcome.ok) {
    db.update(models)
      .set({
        lastTestedAt: new Date(),
        lastTestStatus: "ok",
        lastTestError: null,
        // A model that real work had put away is back on probation (model-health-rules.ts:
        // failuresAfterCheck): the next request that fails puts it away again, and the count of
        // its failures stays, so that each time it is put away it waits longer for its next check.
        checkFailures: sql`CASE WHEN ${models.useFailures} >= ${USE_FAILURES_TO_HIDE} THEN ${models.checkFailures} ELSE 0 END`,
        useFailures: sql`CASE WHEN ${models.useFailures} >= ${USE_FAILURES_TO_HIDE} THEN ${USE_FAILURES_TO_HIDE - 1} ELSE 0 END`,
        retryAt: null,
      })
      .where(eq(models.id, model.id))
      .run();
    // An answer in text verifies the 'text' capability.
    db.insert(modelCapabilities)
      .values({ modelRowId: model.id, capability: "text", verified: true })
      .onConflictDoUpdate({
        target: [modelCapabilities.modelRowId, modelCapabilities.capability],
        set: { verified: true },
      })
      .run();
    recordUsage({
      ...usage,
      apiKeyId,
      promptTokens: outcome.promptTokens,
      completionTokens: outcome.completionTokens,
      estimatedCost: computeCost(model, outcome.promptTokens, outcome.completionTokens),
      status: "ok",
    });
    return;
  }
  db.update(models)
    .set({
      lastTestedAt: new Date(),
      lastTestStatus: "error",
      lastTestError: outcome.error,
      checkFailures: sql`${models.checkFailures} + 1`,
      // Where the provider said when to ask again, the next check is not before that.
      retryAt: typeof outcome.waitMs === "number" && outcome.waitMs > 0 ? new Date(Date.now() + Math.min(outcome.waitMs, RETRY_AT_MAX_MS)) : null,
    })
    .where(eq(models.id, model.id))
    .run();
  recordUsage({ ...usage, apiKeyId, status: "error", errorCode: outcome.code });
}

interface Candidate {
  model: Model;
  provider: Provider;
}

/** The models a check can ask: switched on, on a provider that is switched on and can be spoken to, and answering in text. */
function checkable(): Candidate[] {
  const rows = db
    .select({ model: models, provider: providers })
    .from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(and(eq(models.enabled, true), eq(providers.status, "enabled")))
    .all()
    .filter((row) => adapterIsImplemented(row.provider.adapter));
  if (rows.length === 0) return [];
  const caps = new Map<string, string[]>();
  for (const c of db.select().from(modelCapabilities).all()) {
    const list = caps.get(c.modelRowId) ?? [];
    list.push(c.capability);
    caps.set(c.modelRowId, list);
  }
  return rows.filter((row) => !isMediaOnly(caps.get(row.model.id) ?? []));
}

export interface HealthRound {
  startedAt: number;
  endedAt: number | null;
  /** Who asked for it; null for the automatic check. */
  userId: string | null;
  checked: number;
  passed: number;
  failed: number;
  /** Models that worked before this round and are left out of the lists now, by name. */
  hidden: string[];
  /** Models that were left out and are offered again, by name. */
  restored: string[];
}

interface HealthState {
  running: boolean;
  startedAt: number | null;
  lastRoundAt: number | null;
  last: HealthRound | null;
  lastLookAt: number;
}

/** One per server process: the worker and the request handlers see the same. */
function healthState(): HealthState {
  const cache = runtime().cache;
  let entry = cache.get("model-health");
  if (!entry) {
    entry = { value: { running: false, startedAt: null, lastRoundAt: null, last: null, lastLookAt: 0 } satisfies HealthState, at: Date.now() };
    cache.set("model-health", entry);
  }
  return entry.value as HealthState;
}

function intervalMs(): number {
  return healthIntervalMs(process.env.MODEL_HEALTH_INTERVAL_MINUTES);
}

export interface HealthStatus {
  /** Whether the worker checks the models by itself. */
  automatic: boolean;
  intervalMinutes: number;
  running: boolean;
  lastRoundAt: number | null;
  last: HealthRound | null;
}

export function healthStatus(): HealthStatus {
  const state = healthState();
  const interval = intervalMs();
  return {
    automatic: interval > 0,
    intervalMinutes: Math.round(interval / 60_000),
    running: state.running,
    lastRoundAt: state.lastRoundAt,
    last: state.last,
  };
}

export interface RoundOptions {
  /** These models only, due or not. */
  modelIds?: string[];
  /** Every model that can be checked, due or not. */
  all?: boolean;
  userId?: string | null;
}

/**
 * Check models one after the other. Without options: the ones that are due.
 * Returns null when a round is running already.
 */
export async function runHealthRound(opts: RoundOptions = {}): Promise<HealthRound | null> {
  const state = healthState();
  if (state.running) return null;
  state.running = true;
  state.startedAt = Date.now();
  const userId = opts.userId ?? null;
  const round: HealthRound = { startedAt: state.startedAt, endedAt: null, userId, checked: 0, passed: 0, failed: 0, hidden: [], restored: [] };
  try {
    const interval = intervalMs();
    const now = Date.now();
    const wanted = opts.modelIds ? new Set(opts.modelIds) : null;
    const list = checkable()
      .filter((c) => (wanted ? wanted.has(c.model.id) : opts.all || isDue(c.model, now, interval)))
      .slice(0, ROUND_MAX);
    for (const [index, candidate] of list.entries()) {
      if (stopping()) break;
      if (index > 0) await sleep(PAUSE_MS);
      const { model, provider } = candidate;
      const wasFailing = isFailing(model);
      let outcome = await askModel(model, provider);
      // A limit or a busy moment is often over a little later: a model that worked is asked once more before it is taken away.
      if (!outcome.ok && outcome.kind === "temporary" && !wasFailing) {
        await sleep(secondTryAfterMs());
        if (stopping()) break;
        outcome = await askModel(model, provider);
      }
      // Deleted while it was asked: there is nothing to write on.
      if (!db.select({ id: models.id }).from(models).where(eq(models.id, model.id)).get()) continue;
      recordOutcome(model, provider, outcome, userId);
      round.checked += 1;
      const name = `${model.displayName || model.modelId} · ${provider.name}`;
      if (outcome.ok) {
        round.passed += 1;
        if (wasFailing) {
          round.restored.push(name);
          audit({ actorUserId: userId, action: "model.health.restored", targetType: "model", targetId: model.id, metadata: { model: model.modelId, provider: provider.name } });
        }
      } else {
        round.failed += 1;
        if (!wasFailing) {
          round.hidden.push(name);
          audit({
            actorUserId: userId,
            action: "model.health.hidden",
            targetType: "model",
            targetId: model.id,
            metadata: { model: model.modelId, provider: provider.name, error: outcome.error.slice(0, 200) },
          });
        }
      }
    }
  } finally {
    round.endedAt = Date.now();
    state.running = false;
    state.lastRoundAt = round.endedAt;
    state.last = round;
  }
  return round;
}

/** A step of the background worker: start a round when models are due and none is running. Does not wait for it. */
export function ensureHealthRound(): void {
  const interval = intervalMs();
  if (interval === 0) return;
  const state = healthState();
  const now = Date.now();
  if (state.running || now - state.lastLookAt < LOOK_EVERY_MS) return;
  state.lastLookAt = now;
  if (!checkable().some((c) => isDue(c.model, now, interval))) return;
  void runHealthRound().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[xiero-nexus] the check of the models stopped:", err);
  });
}
