import "server-only";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { sessions, users, type User } from "@/db/schema";
import { randomToken, sha256 } from "./crypto";
import { env } from "./env";

const COOKIE = "nexus_session";
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const TOUCH_AFTER_MS = 5 * 60 * 1000;

export interface SessionRow {
  tokenHash: string;
  userId: string;
  twoFactorPending: boolean;
  expiresAt: Date;
}

function hashToken(token: string): string {
  return sha256(token);
}

export function createSession(
  userId: string,
  opts: { twoFactorPending?: boolean; ip?: string; userAgent?: string } = {},
): string {
  const token = randomToken(32);
  db.insert(sessions)
    .values({
      tokenHash: hashToken(token),
      userId,
      twoFactorPending: opts.twoFactorPending ?? false,
      ip: opts.ip,
      userAgent: opts.userAgent,
      expiresAt: new Date(Date.now() + TTL_MS),
    })
    .run();
  return token;
}

export function setSessionCookie(token: string): void {
  cookies().set(COOKIE, token, {
    httpOnly: true,
    secure: env.isProd,
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(TTL_MS / 1000),
  });
}

export function clearSessionCookie(): void {
  cookies().set(COOKIE, "", {
    httpOnly: true,
    secure: env.isProd,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

/** Read the current session + user, in ANY state (may be 2FA-pending). */
export function readSession(): { session: SessionRow; user: User } | null {
  const token = cookies().get(COOKIE)?.value;
  if (!token) return null;
  const tokenHash = hashToken(token);
  const session = db
    .select()
    .from(sessions)
    .where(eq(sessions.tokenHash, tokenHash))
    .get();
  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) {
    db.delete(sessions).where(eq(sessions.tokenHash, tokenHash)).run();
    return null;
  }
  const user = db.select().from(users).where(eq(users.id, session.userId)).get();
  if (!user || user.status !== "active") return null;

  if (Date.now() - session.lastUsedAt.getTime() > TOUCH_AFTER_MS) {
    db.update(sessions)
      .set({ lastUsedAt: new Date() })
      .where(eq(sessions.tokenHash, tokenHash))
      .run();
  }
  return { session, user };
}

/** Delete the current session row and clear the cookie. */
export function destroyCurrentSession(): void {
  const token = cookies().get(COOKIE)?.value;
  if (token) {
    db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token))).run();
  }
  clearSessionCookie();
}

/** Delete every session for a user (e.g. on password or 2FA change). */
export function destroyAllSessions(userId: string): void {
  db.delete(sessions).where(eq(sessions.userId, userId)).run();
}

/**
 * Issue a fresh token for the current session (rotation), applying a patch.
 * Used after login and after completing the 2FA challenge.
 */
export function rotateCurrentSession(patch: {
  twoFactorPending?: boolean;
}): void {
  const current = readSession();
  if (!current) return;
  const token = randomToken(32);
  db.insert(sessions)
    .values({
      tokenHash: hashToken(token),
      userId: current.session.userId,
      twoFactorPending:
        patch.twoFactorPending ?? current.session.twoFactorPending,
      expiresAt: current.session.expiresAt,
    })
    .run();
  db.delete(sessions)
    .where(eq(sessions.tokenHash, current.session.tokenHash))
    .run();
  setSessionCookie(token);
}
