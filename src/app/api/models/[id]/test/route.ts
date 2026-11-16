import { eq } from "drizzle-orm";
import { db } from "@/db";
import { models, providers } from "@/db/schema";
import { handle, json } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { Errors } from "@/lib/errors";
import { getClientMeta } from "@/lib/request";
import { modelIsMediaOnly } from "@/lib/gateway";
import { askModel, recordOutcome } from "@/lib/model-health";

export const dynamic = "force-dynamic";

/**
 * Send a minimal prompt to verify the model actually responds. Returns the
 * outcome (200) rather than throwing. It is the check the background worker
 * makes by itself (src/lib/model-health.ts): a model that fails it is left out
 * of the model lists until it passes again.
 */
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

  // The test is a chat request, which an image / video model cannot answer.
  if (modelIsMediaOnly(model.id)) {
    throw Errors.badRequest(
      "This model only generates images or videos, so the chat test does not apply. Try it in Creative Studio.",
    );
  }

  const outcome = await askModel(model, provider);
  recordOutcome(model, provider, outcome, user.id);
  audit({
    actorUserId: user.id,
    action: "model.test",
    targetType: "model",
    targetId: model.id,
    metadata: { result: outcome.ok ? "ok" : "error" },
    ip,
    userAgent,
  });
  if (!outcome.ok) return json({ ok: false, error: outcome.error });
  return json({
    ok: true,
    sample: outcome.sample.slice(0, 200),
    usage: { promptTokens: outcome.promptTokens, completionTokens: outcome.completionTokens },
    latencyMs: outcome.latencyMs,
  });
});
