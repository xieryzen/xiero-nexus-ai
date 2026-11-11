import { or, eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { handle, json, parseBody } from "@/lib/api";
import { publicUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { verifyPassword } from "@/lib/crypto";
import { Errors } from "@/lib/errors";
import { rateLimit, rateLimitReset } from "@/lib/ratelimit";
import { getClientMeta } from "@/lib/request";
import { assertSecureTransport, createSession, setSessionCookie } from "@/lib/session";
import { loginSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export const POST = handle(async (req) => {
  assertSecureTransport(req);
  const { ip, userAgent } = getClientMeta(req);
  const body = await parseBody(req, loginSchema);

  const ipKey = `login:ip:${ip}`;
  const idKey = `login:id:${body.identifier.toLowerCase()}`;
  if (!rateLimit(ipKey, 20, 10 * 60_000).ok || !rateLimit(idKey, 10, 10 * 60_000).ok) {
    throw Errors.rateLimited("Too many attempts. Try again later.");
  }

  const identifier = body.identifier.trim();
  const user = db
    .select()
    .from(users)
    .where(
      or(eq(users.username, identifier), eq(users.email, identifier.toLowerCase())),
    )
    .get();

  // Uniform failure to avoid revealing which part was wrong.
  const invalid = () => Errors.unauthorized("Invalid username/email or password");

  if (!user || user.status !== "active") {
    // Still spend time verifying against a dummy hash to reduce timing signal.
    verifyPassword(body.password, "scrypt$16384$8$1$32$AAAA$AAAA");
    throw invalid();
  }
  if (!verifyPassword(body.password, user.passwordHash)) {
    audit({
      actorUserId: user.id,
      action: "auth.login.failed",
      targetType: "user",
      targetId: user.id,
      ip,
      userAgent,
    });
    throw invalid();
  }

  rateLimitReset(ipKey);
  rateLimitReset(idKey);

  if (user.twoFactorEnabled) {
    const token = createSession(user.id, {
      twoFactorPending: true,
      ip,
      userAgent,
    });
    setSessionCookie(token);
    audit({
      actorUserId: user.id,
      action: "auth.login.2fa_required",
      targetType: "user",
      targetId: user.id,
      ip,
      userAgent,
    });
    return json({ ok: true, twoFactorRequired: true });
  }

  const token = createSession(user.id, { ip, userAgent });
  setSessionCookie(token);
  audit({
    actorUserId: user.id,
    action: "auth.login",
    targetType: "user",
    targetId: user.id,
    ip,
    userAgent,
  });
  return json({ ok: true, user: publicUser(user) });
});
