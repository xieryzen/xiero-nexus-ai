import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { models, providers } from "@/db/schema";
import { handle, json, parseBody } from "@/lib/api";
import { requireAdmin, requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { Errors } from "@/lib/errors";
import { getClientMeta } from "@/lib/request";
import { serializeModel, serializeModels, setCapabilities } from "@/lib/models";
import { modelCreateSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export const GET = handle(async (req) => {
  requireUser();
  const url = new URL(req.url);
  const providerId = url.searchParams.get("providerId");
  const rows = providerId
    ? db
        .select()
        .from(models)
        .where(eq(models.providerId, providerId))
        .orderBy(asc(models.modelId))
        .all()
    : db.select().from(models).orderBy(asc(models.modelId)).all();
  return json({ models: serializeModels(rows) });
});

export const POST = handle(async (req) => {
  const user = requireAdmin();
  const { ip, userAgent } = getClientMeta(req);
  const body = await parseBody(req, modelCreateSchema);

  const provider = db
    .select({ id: providers.id })
    .from(providers)
    .where(eq(providers.id, body.providerId))
    .get();
  if (!provider) throw Errors.badRequest("Unknown provider");

  const clash = db
    .select({ id: models.id })
    .from(models)
    .where(and(eq(models.providerId, body.providerId), eq(models.modelId, body.modelId)))
    .get();
  if (clash) throw Errors.conflict("That model already exists for this provider");

  const created = db.transaction((tx) => {
    const m = tx
      .insert(models)
      .values({
        providerId: body.providerId,
        modelId: body.modelId,
        displayName: body.displayName,
        contextWindow: body.contextWindow,
        inputPricePerMTok: body.inputPricePerMTok,
        outputPricePerMTok: body.outputPricePerMTok,
        notes: body.notes,
        source: "manual",
      })
      .returning()
      .get();
    if (body.capabilities?.length) setCapabilities(tx, m.id, body.capabilities);
    return m;
  });

  audit({
    actorUserId: user.id,
    action: "model.create",
    targetType: "model",
    targetId: created.id,
    metadata: { modelId: created.modelId },
    ip,
    userAgent,
  });

  return json({ model: serializeModel(created) }, { status: 201 });
});
