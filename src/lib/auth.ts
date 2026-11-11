import "server-only";
import { cache } from "react";
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
