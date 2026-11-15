import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { Errors } from "@/lib/errors";
import { sendTestWebhook, serializeWebhook, webhookFor } from "@/lib/notifications";
import { maybeSweep, rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

/** Send a test message to the user's webhook now. 502 when it does not arrive. */
export const POST = handle(async () => {
  const user = requireUser();
  maybeSweep();
  const limit = rateLimit(`webhook:test:${user.id}`, 6, 60_000);
  if (!limit.ok) throw Errors.rateLimited("Too many tests. Wait a minute and try again.");
  await sendTestWebhook(user.id);
  return json({ ok: true, webhook: serializeWebhook(webhookFor(user.id)) });
});
