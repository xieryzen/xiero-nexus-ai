import { or, eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { handle, json, parseBody } from "@/lib/api";
import { publicUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { hashPassword } from "@/lib/crypto";
import { Errors } from "@/lib/errors";
import { rateLimit } from "@/lib/ratelimit";
import { getClientMeta } from "@/lib/request";
import { assertSecureTransport, createSession, setSessionCookie } from "@/lib/session";
import { registerSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export const POST = handle(async (req) => {
  assertSecureTransport(req);
  const { ip, userAgent } = getClientMeta(req);
  if (!rateLimit(`register:${ip}`, 10, 10 * 60_000).ok) {
    throw Errors.rateLimited();
  }

  const body = await parseBody(req, registerSchema);

  const clash = db
    .select({ id: users.id, email: users.email, username: users.username })
    .from(users)
    .where(or(eq(users.username, body.username), eq(users.email, body.email)))
    .get();
  if (clash) {
    throw Errors.conflict(
      clash.email === body.email
        ? "An account with that email already exists"
        : "That username is taken",
    );
  }

  // The very first account becomes admin so the instance is manageable.
  const userCount = db.select({ id: users.id }).from(users).all().length;
  const role = userCount === 0 ? "admin" : "user";

  const inserted = db
    .insert(users)
    .values({
      username: body.username,
      email: body.email,
      passwordHash: hashPassword(body.password),
      role,
    })
    .returning()
    .get();

  const token = createSession(inserted.id, { ip, userAgent });
  setSessionCookie(token);
  audit({
    actorUserId: inserted.id,
    action: "user.register",
    targetType: "user",
    targetId: inserted.id,
    metadata: { role },
    ip,
    userAgent,
  });

  return json({ ok: true, user: publicUser(inserted) }, { status: 201 });
});
