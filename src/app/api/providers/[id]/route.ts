import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { providerCredentials, providers } from "@/db/schema";
import { handle, json, parseBody } from "@/lib/api";
import { requireAdmin, requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { Errors } from "@/lib/errors";
import { getClientMeta } from "@/lib/request";
import { assertAllowedBaseUrl, serializeProvider } from "@/lib/providers";
import { encryptSecret, last4 } from "@/lib/secrets";
import { providerUpdateSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

function load(id: string) {
  const p = db.select().from(providers).where(eq(providers.id, id)).get();
  if (!p) throw Errors.notFound("Provider not found");
  return p;
}

export const GET = handle(async (_req, { params }) => {
  requireUser();
  return json({ provider: serializeProvider(load(params.id!)) });
});

export const PATCH = handle(async (req, { params }) => {
  const user = requireAdmin();
  const { ip, userAgent } = getClientMeta(req);
  const existing = load(params.id!);
  const body = await parseBody(req, providerUpdateSchema);

  if (body.baseUrl) await assertAllowedBaseUrl(body.baseUrl);
  const authType = body.authType ?? existing.authType;
  if (authType === "header" && !(body.authHeaderName ?? existing.authHeaderName)) {
    throw Errors.badRequest("Header authentication requires a header name");
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const f of [
    "name",
    "adapter",
    "baseUrl",
    "authType",
    "authHeaderName",
    "apiVersion",
    "mediaApi",
    "timeoutMs",
    "priority",
    "notes",
    "status",
  ] as const) {
    if (body[f] !== undefined) patch[f] = body[f];
  }
  if (body.extraHeaders !== undefined) {
    patch.extraHeaders = body.extraHeaders ? JSON.stringify(body.extraHeaders) : null;
  }

  db.update(providers).set(patch).where(eq(providers.id, existing.id)).run();

  // Rotate credential if a new key was supplied.
  if (body.apiKey) {
    db.update(providerCredentials)
      .set({ status: "disabled", updatedAt: new Date() })
      .where(
        and(
          eq(providerCredentials.providerId, existing.id),
          eq(providerCredentials.status, "active"),
        ),
      )
      .run();
    db.insert(providerCredentials)
      .values({
        providerId: existing.id,
        ciphertext: encryptSecret(body.apiKey),
        last4: last4(body.apiKey),
        rotatedAt: new Date(),
      })
      .run();
  }

  audit({
    actorUserId: user.id,
    action: "provider.update",
    targetType: "provider",
    targetId: existing.id,
    metadata: { fields: Object.keys(patch), rotatedKey: Boolean(body.apiKey) },
    ip,
    userAgent,
  });

  return json({ provider: serializeProvider(load(existing.id)) });
});

export const DELETE = handle(async (req, { params }) => {
  const user = requireAdmin();
  const { ip, userAgent } = getClientMeta(req);
  const existing = load(params.id!);
  db.delete(providers).where(eq(providers.id, existing.id)).run();
  audit({
    actorUserId: user.id,
    action: "provider.delete",
    targetType: "provider",
    targetId: existing.id,
    metadata: { name: existing.name },
    ip,
    userAgent,
  });
  return json({ ok: true });
});
