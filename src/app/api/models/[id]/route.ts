import { eq } from "drizzle-orm";
import { db } from "@/db";
import { models } from "@/db/schema";
import { handle, json, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { Errors } from "@/lib/errors";
import { getClientMeta } from "@/lib/request";
import { serializeModel, setCapabilities } from "@/lib/models";
import { modelUpdateSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

function load(id: string) {
  const m = db.select().from(models).where(eq(models.id, id)).get();
  if (!m) throw Errors.notFound("Model not found");
  return m;
}

export const PATCH = handle(async (req, { params }) => {
  const user = requireAdmin();
  const { ip, userAgent } = getClientMeta(req);
  const existing = load(params.id!);
  const body = await parseBody(req, modelUpdateSchema);

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const f of [
    "displayName",
    "enabled",
    "contextWindow",
    "inputPricePerMTok",
    "outputPricePerMTok",
    "notes",
  ] as const) {
    if (body[f] !== undefined) patch[f] = body[f];
  }

  db.transaction((tx) => {
    tx.update(models).set(patch).where(eq(models.id, existing.id)).run();
    if (body.capabilities) setCapabilities(tx, existing.id, body.capabilities);
  });

  audit({
    actorUserId: user.id,
    action: "model.update",
    targetType: "model",
    targetId: existing.id,
    metadata: { fields: Object.keys(patch) },
    ip,
    userAgent,
  });

  return json({ model: serializeModel(load(existing.id)) });
});

export const DELETE = handle(async (req, { params }) => {
  const user = requireAdmin();
  const { ip, userAgent } = getClientMeta(req);
  const existing = load(params.id!);
  db.delete(models).where(eq(models.id, existing.id)).run();
  audit({
    actorUserId: user.id,
    action: "model.delete",
    targetType: "model",
    targetId: existing.id,
    metadata: { modelId: existing.modelId },
    ip,
    userAgent,
  });
  return json({ ok: true });
});
