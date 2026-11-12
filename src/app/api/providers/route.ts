import { asc } from "drizzle-orm";
import { db } from "@/db";
import { providerCredentials, providers } from "@/db/schema";
import { handle, json, parseBody } from "@/lib/api";
import { requireAdmin, requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { Errors } from "@/lib/errors";
import { getClientMeta } from "@/lib/request";
import { assertAllowedBaseUrl, serializeProvider } from "@/lib/providers";
import { encryptSecret, last4 } from "@/lib/secrets";
import { providerCreateSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  requireUser();
  const rows = db
    .select()
    .from(providers)
    .orderBy(asc(providers.priority), asc(providers.name))
    .all();
  return json({ providers: rows.map(serializeProvider) });
});

export const POST = handle(async (req) => {
  const user = requireAdmin();
  const { ip, userAgent } = getClientMeta(req);
  const body = await parseBody(req, providerCreateSchema);

  if (body.authType === "header" && !body.authHeaderName) {
    throw Errors.badRequest("Header authentication requires a header name");
  }
  if (body.authType !== "none" && !body.apiKey) {
    throw Errors.badRequest("An API key is required for this authentication type");
  }
  await assertAllowedBaseUrl(body.baseUrl);

  const provider = db
    .insert(providers)
    .values({
      name: body.name,
      adapter: body.adapter,
      baseUrl: body.baseUrl,
      authType: body.authType,
      authHeaderName: body.authHeaderName,
      apiVersion: body.apiVersion,
      mediaApi: body.mediaApi ?? "auto",
      timeoutMs: body.timeoutMs,
      extraHeaders: body.extraHeaders ? JSON.stringify(body.extraHeaders) : null,
      priority: body.priority,
      notes: body.notes,
      createdBy: user.id,
    })
    .returning()
    .get();

  if (body.apiKey) {
    db.insert(providerCredentials)
      .values({
        providerId: provider.id,
        ciphertext: encryptSecret(body.apiKey),
        last4: last4(body.apiKey),
      })
      .run();
  }

  audit({
    actorUserId: user.id,
    action: "provider.create",
    targetType: "provider",
    targetId: provider.id,
    metadata: { name: provider.name, adapter: provider.adapter },
    ip,
    userAgent,
  });

  return json({ provider: serializeProvider(provider) }, { status: 201 });
});
