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

export const dynamic = "force-dynamic";

const schema = z.object({ password: z.string().min(1, "Confirm your password") });

/** Regenerate recovery codes (invalidates all previous codes). */
export const POST = handle(async (req) => {
  const user = requireUser();
  const { ip, userAgent } = getClientMeta(req);
  if (!rateLimit(`2fa-recovery:${user.id}`, 5, 10 * 60_000).ok) {
    throw Errors.rateLimited();
  }
  if (!user.twoFactorEnabled) {
    throw Errors.badRequest("Two-factor authentication is not enabled");
  }

  const body = await parseBody(req, schema);
  if (!verifyPassword(body.password, user.passwordHash)) {
    throw Errors.unauthorized("Password is incorrect");
  }

  const codes = generateRecoveryCodes(10);
  db.transaction((tx) => {
    tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, user.id)).run();
    for (const c of codes) {
      tx.insert(recoveryCodes).values({ userId: user.id, codeHash: c.hash }).run();
    }
    tx.update(users).set({ updatedAt: new Date() }).where(eq(users.id, user.id)).run();
  });

  audit({
    actorUserId: user.id,
    action: "account.2fa.recovery_regenerated",
    targetType: "user",
    targetId: user.id,
    ip,
    userAgent,
  });

  return json({ ok: true, recoveryCodes: codes.map((c) => c.code) });
});
