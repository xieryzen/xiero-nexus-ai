import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { models, providers } from "@/db/schema";
import { handle, json, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { AppError, Errors, sanitizeUpstreamError } from "@/lib/errors";
import { getClientMeta } from "@/lib/request";
import { discoverProviderModels } from "@/lib/gateway";

export const dynamic = "force-dynamic";

const schema = z.object({
  import: z.array(z.string().min(1).max(200)).max(500).optional(),
});

/** Discover upstream models; optionally import a selected subset. */
export const POST = handle(async (req, { params }) => {
  const user = requireAdmin();
  const { ip, userAgent } = getClientMeta(req);
  const provider = db
    .select()
    .from(providers)
    .where(eq(providers.id, params.id!))
    .get();
  if (!provider) throw Errors.notFound("Provider not found");

  const body = await parseBody(req, schema);

  let discovered: string[];
  try {
    discovered = await discoverProviderModels(provider);
  } catch (err) {
    const message =
      err instanceof AppError ? err.message : sanitizeUpstreamError(err);
    return json({ ok: false, error: message });
  }

  const existing = new Set(
    db
      .select({ modelId: models.modelId })
      .from(models)
      .where(eq(models.providerId, provider.id))
      .all()
      .map((m) => m.modelId),
  );

  let imported = 0;
  if (body.import?.length) {
    const toImport = body.import.filter(
      (id) => discovered.includes(id) && !existing.has(id),
    );
    db.transaction((tx) => {
      for (const modelId of toImport) {
        tx.insert(models)
          .values({ providerId: provider.id, modelId, source: "discovered" })
          .run();
        imported++;
      }
    });
    if (imported > 0) {
      audit({
        actorUserId: user.id,
        action: "model.import",
        targetType: "provider",
        targetId: provider.id,
        metadata: { count: imported },
        ip,
        userAgent,
      });
    }
  }

  return json({
    ok: true,
    models: discovered,
    existing: [...existing],
    imported,
  });
});
