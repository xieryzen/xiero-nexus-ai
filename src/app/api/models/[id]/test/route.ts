import { eq } from "drizzle-orm";
import { db } from "@/db";
import { modelCapabilities, models, providers } from "@/db/schema";
import { handle, json } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { AppError, Errors, sanitizeUpstreamError } from "@/lib/errors";
import { getClientMeta } from "@/lib/request";
import { gatewayChat } from "@/lib/gateway";
import { computeCost, estimateTokens, recordUsage } from "@/lib/usage";

export const dynamic = "force-dynamic";

/** Send a minimal prompt to verify the model actually responds. Returns the
 * outcome (200) rather than throwing. */
export const POST = handle(async (req, { params }) => {
  const user = requireAdmin();
  const { ip, userAgent } = getClientMeta(req);
  const model = db.select().from(models).where(eq(models.id, params.id!)).get();
  if (!model) throw Errors.notFound("Model not found");
  const provider = db
    .select()
    .from(providers)
    .where(eq(providers.id, model.providerId))
    .get();
  if (!provider) throw Errors.notFound("Provider not found");

  const started = Date.now();
  try {
    const result = await gatewayChat(
      { model, provider },
      [{ role: "user", content: "Reply with the single word: ok" }],
      { temperature: 0 },
    );
    const latencyMs = Date.now() - started;
    const promptTokens =
      result.usage?.promptTokens ?? estimateTokens("Reply with the single word: ok");
    const completionTokens =
      result.usage?.completionTokens ?? estimateTokens(result.content);

    db.update(models)
      .set({ lastTestedAt: new Date(), lastTestStatus: "ok", lastTestError: null })
      .where(eq(models.id, model.id))
      .run();
    // A successful text completion verifies the 'text' capability.
    db.insert(modelCapabilities)
      .values({ modelRowId: model.id, capability: "text", verified: true })
      .onConflictDoUpdate({
        target: [modelCapabilities.modelRowId, modelCapabilities.capability],
        set: { verified: true },
      })
      .run();

    recordUsage({
      userId: user.id,
      providerId: provider.id,
      modelRowId: model.id,
      kind: "test",
      promptTokens,
      completionTokens,
      estimatedCost: computeCost(model, promptTokens, completionTokens),
      status: "ok",
      latencyMs,
    });
    audit({
      actorUserId: user.id,
      action: "model.test",
      targetType: "model",
      targetId: model.id,
      metadata: { result: "ok" },
      ip,
      userAgent,
    });

    return json({
      ok: true,
      sample: result.content.slice(0, 200),
      usage: { promptTokens, completionTokens },
      latencyMs,
    });
  } catch (err) {
    const message = err instanceof AppError ? err.message : sanitizeUpstreamError(err);
    db.update(models)
      .set({ lastTestedAt: new Date(), lastTestStatus: "error", lastTestError: message })
      .where(eq(models.id, model.id))
      .run();
    recordUsage({
      userId: user.id,
      providerId: provider.id,
      modelRowId: model.id,
      kind: "test",
      status: "error",
      errorCode: err instanceof AppError ? err.code : "error",
      latencyMs: Date.now() - started,
    });
    audit({
      actorUserId: user.id,
      action: "model.test",
      targetType: "model",
      targetId: model.id,
      metadata: { result: "error" },
      ip,
      userAgent,
    });
    return json({ ok: false, error: message });
  }
});
