import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import type { User } from "@/db/schema";
import { Errors } from "./errors";
import { readSession } from "./session";

export type SessionState =
  | { status: "none" }
  | { status: "pending"; user: User } // password OK, awaiting 2FA
  | { status: "active"; user: User };

/** Full session state, cached per request. */
export const getSessionState = cache((): SessionState => {
  const s = readSession();
  if (!s) return { status: "none" };
  if (s.session.twoFactorPending) return { status: "pending", user: s.user };
  return { status: "active", user: s.user };
});

/** The current fully-authenticated user, or null. */
export function getCurrentUser(): User | null {
  const state = getSessionState();
  return state.status === "active" ? state.user : null;
}

/**
 * The signed-in user of a dashboard page. The dashboard layout sends everyone
 * else to the sign-in page, but a page is rendered alongside its layout, so
 * it makes the same decision here instead of assuming there is a user.
 */
export function requirePageUser(): User {
  const state = getSessionState();
  if (state.status === "none") redirect("/login");
  if (state.status === "pending") redirect("/login/2fa");
  return state.user;
}

/** Require a fully-authenticated user (for API routes). Throws AppError. */
export function requireUser(): User {
  const user = getCurrentUser();
  if (!user) throw Errors.unauthorized();
  return user;
}

/** Require an admin user. Throws AppError. */
export function requireAdmin(): User {
  const user = requireUser();
  if (user.role !== "admin") throw Errors.forbidden();
  return user;
}

/** Public-safe shape of a user (never includes secrets). */
export function publicUser(user: User) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    status: user.status,
    twoFactorEnabled: user.twoFactorEnabled,
    createdAt: user.createdAt,
  };
}

export type PublicUser = ReturnType<typeof publicUser>;
