import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { recoveryCodes, users } from "@/db/schema";
import { handle, json, parseBody } from "@/lib/api";
import { getSessionState, publicUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { sha256 } from "@/lib/crypto";
import { Errors } from "@/lib/errors";
import { rateLimit } from "@/lib/ratelimit";
import { getClientMeta } from "@/lib/request";
import { rotateCurrentSession } from "@/lib/session";
import { decryptSecret } from "@/lib/secrets";
import { verifyTotp } from "@/lib/totp";
import { recoveryCodeSchema, totpTokenSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

const schema = z
  .object({
    token: totpTokenSchema.optional(),
    recoveryCode: recoveryCodeSchema.optional(),
  })
  .refine((v) => v.token || v.recoveryCode, {
    message: "Provide a 6-digit code or a recovery code",
  });

function normalizeRecovery(input: string): string {
  const s = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : input.trim().toUpperCase();
}

/** Complete the 2FA challenge for a password-verified (pending) session. */
export const POST = handle(async (req) => {
  const { ip, userAgent } = getClientMeta(req);
  const state = getSessionState();
  if (state.status === "none") throw Errors.unauthorized();
  if (state.status === "active") return json({ ok: true }); // already satisfied

  const user = state.user;
  if (!rateLimit(`2fa:${user.id}`, 8, 5 * 60_000).ok) {
    throw Errors.rateLimited("Too many attempts. Try again later.");
  }
  if (!user.twoFactorEnabled || !user.twoFactorSecret) {
    throw Errors.badRequest("Two-factor authentication is not enabled");
  }

  const body = await parseBody(req, schema);
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
        .where(
          and(eq(recoveryCodes.id, row.id), isNull(recoveryCodes.usedAt)),
        )
        .run();
      return res.changes === 1;
    });
  }

  if (!verified) {
    audit({
      actorUserId: user.id,
      action: "auth.2fa.failed",
      targetType: "user",
      targetId: user.id,
      ip,
      userAgent,
    });
    throw Errors.unauthorized("Invalid code");
  }

  rotateCurrentSession({ twoFactorPending: false });
  audit({
    actorUserId: user.id,
    action: body.recoveryCode ? "auth.2fa.recovery_used" : "auth.2fa.verified",
    targetType: "user",
    targetId: user.id,
    ip,
    userAgent,
  });
  const fresh = db.select().from(users).where(eq(users.id, user.id)).get()!;
  return json({ ok: true, user: publicUser(fresh) });
});
