import { eq } from "drizzle-orm";
import { db } from "@/db";
import { providers } from "@/db/schema";
import { handle, json } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { AppError, Errors, sanitizeUpstreamError } from "@/lib/errors";
import { getClientMeta } from "@/lib/request";
import { testProviderConnection } from "@/lib/gateway";

export const dynamic = "force-dynamic";

/** Test a provider connection server-side. Returns the outcome (200) rather
 * than throwing, so a failed provider test renders inline safely. */
export const POST = handle(async (req, { params }) => {
  const user = requireAdmin();
  const { ip, userAgent } = getClientMeta(req);
  const provider = db
    .select()
    .from(providers)
    .where(eq(providers.id, params.id!))
    .get();
  if (!provider) throw Errors.notFound("Provider not found");

  const body = (await req.json().catch(() => ({}))) as { apiKey?: unknown };
  const apiKey = typeof body.apiKey === "string" && body.apiKey ? body.apiKey : null;

  try {
    await testProviderConnection(provider, apiKey);
    db.update(providers)
      .set({ lastTestedAt: new Date(), lastTestStatus: "ok", lastTestError: null })
      .where(eq(providers.id, provider.id))
      .run();
    audit({
      actorUserId: user.id,
      action: "provider.test",
      targetType: "provider",
      targetId: provider.id,
      metadata: { result: "ok" },
      ip,
      userAgent,
    });
    return json({ ok: true, status: "ok" });
  } catch (err) {
    const message =
      err instanceof AppError ? err.message : sanitizeUpstreamError(err);
    db.update(providers)
      .set({ lastTestedAt: new Date(), lastTestStatus: "error", lastTestError: message })
      .where(eq(providers.id, provider.id))
      .run();
    audit({
      actorUserId: user.id,
      action: "provider.test",
      targetType: "provider",
      targetId: provider.id,
      metadata: { result: "error" },
      ip,
      userAgent,
    });
    return json({ ok: false, status: "error", error: message });
  }
});
