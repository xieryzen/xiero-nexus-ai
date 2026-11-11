import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { Errors } from "@/lib/errors";
import { rateLimit } from "@/lib/ratelimit";
import { getClientMeta } from "@/lib/request";
import { encryptSecret } from "@/lib/secrets";
import { generateTotpSecret, qrDataUrl, totpKeyUri } from "@/lib/totp";

export const dynamic = "force-dynamic";

/** Begin TOTP enrollment: generate a secret and return its QR + manual key. */
export const POST = handle(async (req) => {
  const user = requireUser();
  const { ip, userAgent } = getClientMeta(req);
  if (!rateLimit(`2fa-setup:${user.id}`, 10, 10 * 60_000).ok) {
    throw Errors.rateLimited();
  }
  if (user.twoFactorEnabled) {
    throw Errors.conflict("Two-factor authentication is already enabled");
  }

  const secret = generateTotpSecret();
  db.update(users)
    .set({ twoFactorSecret: encryptSecret(secret), updatedAt: new Date() })
    .where(eq(users.id, user.id))
    .run();

  const otpauthUri = totpKeyUri(secret, user.email);
  const qr = await qrDataUrl(otpauthUri);

  audit({
    actorUserId: user.id,
    action: "account.2fa.setup_started",
    targetType: "user",
    targetId: user.id,
    ip,
    userAgent,
  });

  // The secret is shown ONCE during setup for manual entry; it is never
  // returned by profile endpoints or on subsequent loads.
  return json({ ok: true, secret, otpauthUri, qr });
});
