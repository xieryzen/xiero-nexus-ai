import { handle, json, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { deleteWebhook, saveWebhook, serializeWebhook, webhookFor } from "@/lib/notifications";
import { getClientMeta } from "@/lib/request";
import { webhookSaveSchema } from "@/lib/validation";
import { kickWorker } from "@/lib/worker";

export const dynamic = "force-dynamic";

/** Where the user's notifications are also sent. */
export const GET = handle(async () => {
  const user = requireUser();
  return json({ webhook: serializeWebhook(webhookFor(user.id)) });
});

/**
 * Set the webhook. The answer to the first save carries the signing secret,
 * which is shown this once; ?rotate=1 makes a new one.
 */
export const PUT = handle(async (req) => {
  const user = requireUser();
  const { ip, userAgent } = getClientMeta(req);
  const body = await parseBody(req, webhookSaveSchema);
  const rotateSecret = new URL(req.url).searchParams.get("rotate") === "1";
  const { hook, secret } = await saveWebhook(user.id, {
    url: body.url,
    enabled: body.enabled ?? true,
    rotateSecret,
  });
  audit({
    actorUserId: user.id,
    action: "webhook.save",
    targetType: "user",
    targetId: user.id,
    metadata: { host: new URL(hook.url).host, enabled: hook.enabled, newSecret: Boolean(secret) },
    ip,
    userAgent,
  });
  kickWorker();
  return json({ webhook: serializeWebhook(hook), secret });
});

export const DELETE = handle(async (req) => {
  const user = requireUser();
  const { ip, userAgent } = getClientMeta(req);
  deleteWebhook(user.id);
  audit({ actorUserId: user.id, action: "webhook.delete", targetType: "user", targetId: user.id, ip, userAgent });
  return json({ ok: true });
});
