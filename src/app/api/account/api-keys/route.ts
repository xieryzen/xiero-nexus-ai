import { apiKeyFor } from "@/lib/for-viewer";
import { seesSetup } from "@/lib/roles";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { models } from "@/db/schema";
import { createApiKey, listApiKeys, serializeApiKey } from "@/lib/apikeys";
import { handle, json, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { Errors } from "@/lib/errors";
import { getClientMeta } from "@/lib/request";
import { apiKeyCreateSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** The user's API keys. The keys themselves are not stored and cannot be shown. */
export const GET = handle(async () => {
  const user = requireUser();
  return json({ keys: listApiKeys(user.id).map((key) => apiKeyFor(user.role, serializeApiKey(key))) });
});

/** Make a key. The answer carries the key itself, this once. */
export const POST = handle(async (req) => {
  const user = requireUser();
  const { ip, userAgent } = getClientMeta(req);
  const body = await parseBody(req, apiKeyCreateSchema);
  // A key of an account that chooses no model is limited to none, and has no
  // limit in money: its account is shown neither the models nor what they cost.
  if (!seesSetup(user.role)) {
    body.modelRowIds = null;
    body.monthlyCostLimit = null;
  }
  if (body.modelRowIds?.length) {
    const found = db
      .select({ id: models.id })
      .from(models)
      .where(inArray(models.id, body.modelRowIds))
      .all();
    if (found.length !== new Set(body.modelRowIds).size) {
      throw Errors.badRequest("One of the chosen models does not exist");
    }
  }
  const { key, secret } = createApiKey(user.id, body);
  audit({
    actorUserId: user.id,
    action: "apikey.create",
    targetType: "apikey",
    targetId: key.id,
    metadata: { name: key.name, scopes: body.scopes, prefix: key.prefix },
    ip,
    userAgent,
  });
  return json({ key: apiKeyFor(user.role, serializeApiKey(key)), secret }, { status: 201 });
});
