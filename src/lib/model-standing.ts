import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { models, type Model, type Provider } from "@/db/schema";
import { audit } from "./audit";
import { AppError, sanitizeUpstreamError } from "./errors";
import { afterUseFailure, isFailing, useOutcome } from "./model-health-rules";
import { limitOf } from "./upstream";

/**
 * What real work says about a model, written down as it happens: every chat
 * request that goes through the gateway ends here, answered or not. The rules
 * are in model-health-rules.ts.
 *
 * A model that answers is known to work, which a check then need not ask. A
 * model that does not answer rests, and after three requests in a row, or one
 * answer that asking again does not change, it is put away as a failed check
 * puts it away: left out of the lists and of the app's choice until a check
 * passes.
 */

/** An answer does not have to be written down more often than this. */
const NOTE_EVERY_MS = 2 * 60_000;

function current(id: string) {
  return db
    .select({
      lastTestedAt: models.lastTestedAt,
      lastTestStatus: models.lastTestStatus,
      checkFailures: models.checkFailures,
      useFailures: models.useFailures,
      retryAt: models.retryAt,
    })
    .from(models)
    .where(eq(models.id, id))
    .get();
}

/** The model answered a request. */
export function noteAnswer(model: Model, provider: Provider): void {
  try {
    const now = Date.now();
    const row = current(model.id);
    if (!row) return;
    const wasFailing = isFailing(row);
    const fresh = row.lastTestStatus === "ok" && row.lastTestedAt !== null && now - row.lastTestedAt.getTime() < NOTE_EVERY_MS;
    if (fresh && row.useFailures === 0 && row.retryAt === null) return;
    db.update(models)
      .set({ lastTestedAt: new Date(now), lastTestStatus: "ok", lastTestError: null, checkFailures: 0, useFailures: 0, retryAt: null })
      .where(eq(models.id, model.id))
      .run();
    if (wasFailing) {
      audit({
        actorUserId: null,
        action: "model.health.restored",
        targetType: "model",
        targetId: model.id,
        metadata: { model: model.modelId, provider: provider.name, by: "use" },
      });
    }
  } catch {
    // What a model is known for is not worth failing the request that it answered.
  }
}

/** A request to the model failed with this error. */
export function noteFailure(model: Model, provider: Provider, err: unknown): void {
  try {
    const message = err instanceof AppError ? err.message : sanitizeUpstreamError(err);
    const code = err instanceof AppError ? err.code : "error";
    const outcome = useOutcome({ code, message, limit: limitOf(err) });
    if (outcome.kind === "none") return;
    const row = current(model.id);
    if (!row) return;
    const now = Date.now();
    const wasFailing = isFailing(row);
    const verdict = afterUseFailure({ failing: wasFailing, useFailures: row.useFailures }, outcome, now);
    if (!verdict) return;
    // A time the provider named is kept when it is later than the one that is there.
    const retryAt = verdict.retryAt === null ? row.retryAt : new Date(Math.max(verdict.retryAt, row.retryAt?.getTime() ?? 0));
    if (verdict.failing && !wasFailing) {
      db.update(models)
        .set({
          useFailures: sql`${models.useFailures} + 1`,
          retryAt,
          lastTestedAt: new Date(now),
          lastTestStatus: "error",
          lastTestError: message,
          checkFailures: Math.max(row.checkFailures, 1),
        })
        .where(eq(models.id, model.id))
        .run();
      audit({
        actorUserId: null,
        action: "model.health.hidden",
        targetType: "model",
        targetId: model.id,
        metadata: { model: model.modelId, provider: provider.name, by: "use", error: message.slice(0, 200) },
      });
      return;
    }
    // Resting, or put away already: the time of its last check stays, so that the check still comes when it is due.
    db.update(models)
      .set({ useFailures: sql`${models.useFailures} + 1`, retryAt, ...(wasFailing ? { lastTestError: message } : {}) })
      .where(eq(models.id, model.id))
      .run();
  } catch {
    // The request's own error is the one that matters.
  }
}
