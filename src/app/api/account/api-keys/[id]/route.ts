import { revokeApiKey, serializeApiKey } from "@/lib/apikeys";
import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { Errors } from "@/lib/errors";
import { getClientMeta } from "@/lib/request";

export const dynamic = "force-dynamic";

/** Revoke a key. It stops working at once and cannot be brought back. */
export const DELETE = handle(async (req, { params }) => {
  const user = requireUser();
  const { ip, userAgent } = getClientMeta(req);
  const key = revokeApiKey(user.id, params.id!);
  if (!key) throw Errors.notFound("API key not found");
  audit({
    actorUserId: user.id,
    action: "apikey.revoke",
    targetType: "apikey",
    targetId: key.id,
    metadata: { name: key.name, prefix: key.prefix },
    ip,
    userAgent,
  });
  return json({ key: serializeApiKey(key) });
});
