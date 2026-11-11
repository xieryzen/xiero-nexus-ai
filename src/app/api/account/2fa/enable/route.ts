import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { recoveryCodes, users } from "@/db/schema";
import { handle, json, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { generateRecoveryCodes, verifyPassword } from "@/lib/crypto";
import { Errors } from "@/lib/errors";
import { rateLimit } from "@/lib/ratelimit";
import { getClientMeta } from "@/lib/request";
import { decryptSecret } from "@/lib/secrets";
import { createSession, destroyAllSessions, setSessionCookie } from "@/lib/session";
import { verifyTotp } from "@/lib/totp";
import { totpTokenSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

const schema = z.object({
  password: z.string().min(1, "Confirm your password"),
  token: totpTokenSchema,
});

/** Activate TOTP after re-authentication and verifying the first code. */
export const POST = handle(async (req) => {
  const user = requireUser();
  const { ip, userAgent } = getClientMeta(req);
  if (!rateLimit(`2fa-enable:${user.id}`, 10, 10 * 60_000).ok) {
    throw Errors.rateLimited();
  }
  if (user.twoFactorEnabled) {
    throw Errors.conflict("Two-factor authentication is already enabled");
  }
  if (!user.twoFactorSecret) {
    throw Errors.badRequest("Start 2FA setup first");
  }

  const body = await parseBody(req, schema);
  if (!verifyPassword(body.password, user.passwordHash)) {
    throw Errors.unauthorized("Password is incorrect");
  }
  if (!verifyTotp(body.token, decryptSecret(user.twoFactorSecret))) {
    throw Errors.badRequest("That code is not valid. Check your authenticator and try again.");
  }

  const codes = generateRecoveryCodes(10);
  db.transaction((tx) => {
    tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, user.id)).run();
    for (const c of codes) {
      tx.insert(recoveryCodes).values({ userId: user.id, codeHash: c.hash }).run();
    }
    tx.update(users)
      .set({
        twoFactorEnabled: true,
        twoFactorConfirmedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id))
      .run();
  });

  // Privilege change: invalidate all sessions, then re-establish this device.
  destroyAllSessions(user.id);
  const token = createSession(user.id, { ip, userAgent });
  setSessionCookie(token);

  audit({
    actorUserId: user.id,
    action: "account.2fa.enabled",
    targetType: "user",
    targetId: user.id,
    ip,
    userAgent,
  });

  return json({ ok: true, recoveryCodes: codes.map((c) => c.code) });
});
