import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { recoveryCodes, users } from "@/db/schema";
import { handle, json, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { sha256, verifyPassword } from "@/lib/crypto";
import { Errors } from "@/lib/errors";
import { rateLimit } from "@/lib/ratelimit";
import { getClientMeta } from "@/lib/request";
import { decryptSecret } from "@/lib/secrets";
import { createSession, destroyAllSessions, setSessionCookie } from "@/lib/session";
import { verifyTotp } from "@/lib/totp";
import { recoveryCodeSchema, totpTokenSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

const schema = z
  .object({
    password: z.string().min(1, "Confirm your password"),
    token: totpTokenSchema.optional(),
    recoveryCode: recoveryCodeSchema.optional(),
  })
  .refine((v) => v.token || v.recoveryCode, {
    message: "Provide a current 6-digit code or a recovery code",
  });

function normalizeRecovery(input: string): string {
  const s = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : input.trim().toUpperCase();
}

/** Turn off TOTP after re-authentication and a valid current factor. */
export const POST = handle(async (req) => {
  const user = requireUser();
  const { ip, userAgent } = getClientMeta(req);
  if (!rateLimit(`2fa-disable:${user.id}`, 10, 10 * 60_000).ok) {
    throw Errors.rateLimited();
  }
  if (!user.twoFactorEnabled || !user.twoFactorSecret) {
    throw Errors.badRequest("Two-factor authentication is not enabled");
  }

  const body = await parseBody(req, schema);
  if (!verifyPassword(body.password, user.passwordHash)) {
    throw Errors.unauthorized("Password is incorrect");
  }

  let verified = false;
  if (body.token) {
    verified = verifyTotp(body.token, decryptSecret(user.twoFactorSecret));
  } else if (body.recoveryCode) {
    const hash = sha256(normalizeRecovery(body.recoveryCode));
    verified = db.transaction((tx) => {
      const row = tx
        .select()
        .from(recoveryCodes)
        .where(
          and(
            eq(recoveryCodes.userId, user.id),
            eq(recoveryCodes.codeHash, hash),
            isNull(recoveryCodes.usedAt),
          ),
        )
        .get();
      if (!row) return false;
      const res = tx
        .update(recoveryCodes)
        .set({ usedAt: new Date() })
        .where(and(eq(recoveryCodes.id, row.id), isNull(recoveryCodes.usedAt)))
        .run();
      return res.changes === 1;
    });
  }
  if (!verified) throw Errors.unauthorized("Invalid code");

  db.transaction((tx) => {
    tx.update(users)
      .set({
        twoFactorEnabled: false,
        twoFactorSecret: null,
        twoFactorConfirmedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id))
      .run();
    tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, user.id)).run();
  });

  destroyAllSessions(user.id);
  const token = createSession(user.id, { ip, userAgent });
  setSessionCookie(token);

  audit({
    actorUserId: user.id,
    action: "account.2fa.disabled",
    targetType: "user",
    targetId: user.id,
    ip,
    userAgent,
  });

  return json({ ok: true });
});
