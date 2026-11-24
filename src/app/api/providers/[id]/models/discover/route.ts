import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { models, providers } from "@/db/schema";
import { handle, json, parseBody } from "@/lib/api";
import { requireSetupOwner } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { AppError, Errors, sanitizeUpstreamError } from "@/lib/errors";
import { getClientMeta } from "@/lib/request";
import type { ListedModel } from "@/lib/adapters/types";
import { suggestModel } from "@/lib/discovery";
import { discoverProviderModels } from "@/lib/gateway";
import { setCapabilities } from "@/lib/models";

export const dynamic = "force-dynamic";

const schema = z.object({
  import: z.array(z.string().min(1).max(200)).max(500).optional(),
});

/** Discover upstream models; optionally import a selected subset. */
export const POST = handle(async (req, { params }) => {
  const user = requireSetupOwner();
  const { ip, userAgent } = getClientMeta(req);
  const provider = db
    .select()
    .from(providers)
    .where(eq(providers.id, params.id!))
    .get();
  if (!provider) throw Errors.notFound("Provider not found");

  const body = await parseBody(req, schema);

  let listed: ListedModel[];
  try {
    listed = await discoverProviderModels(provider);
  } catch (err) {
    const message =
      err instanceof AppError ? err.message : sanitizeUpstreamError(err);
    return json({ ok: false, error: message });
  }
  const discovered = listed.map((m) => m.id);
  // What each model is for: from the provider's list, else guessed from its id.
  const suggested = new Map(listed.map((m) => [m.id, suggestModel(m)] as const));
  const pricing = new Map(
    listed
      .filter((m) => m.billed !== undefined)
      .map((m) => [m.id, { billed: m.billed!, inputPricePerMTok: m.inputPricePerMTok, outputPricePerMTok: m.outputPricePerMTok }] as const),
  );

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
    const toImport = [...new Set(body.import)].filter(
      (id) => suggested.has(id) && !existing.has(id),
    );
    db.transaction((tx) => {
      for (const modelId of toImport) {
        const suggestion = suggested.get(modelId)!;
        const row = tx
          .insert(models)
          .values({
            providerId: provider.id,
            modelId,
            displayName: suggestion.displayName ?? null,
            contextWindow: suggestion.contextWindow ?? null,
            // What the provider's list says of its price, where it says so.
            inputPricePerMTok: pricing.get(modelId)?.inputPricePerMTok ?? null,
            outputPricePerMTok: pricing.get(modelId)?.outputPricePerMTok ?? null,
            source: "discovered",
          })
          .returning({ id: models.id })
          .get();
        // Unverified, like capabilities set by hand: they are a starting point.
        setCapabilities(tx, row.id, suggestion.capabilities);
        existing.add(modelId);
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
    suggested: Object.fromEntries(
      [...suggested].map(([id, s]) => [id, { type: s.type, capabilities: s.capabilities, ...(pricing.get(id) ?? {}) }]),
    ),
    // Whether the provider's list says what its models cost at all.
    pricesListed: pricing.size > 0,
    existing: [...existing],
    imported,
  });
});
