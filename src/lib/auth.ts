import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import type { User } from "@/db/schema";
import { Errors } from "./errors";
import { isAdminRole, isOwnerRole, tierOf } from "./roles";
import { readSession } from "./session";
import { tokensOf } from "./tokens";

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

/** Require an administrator: an admin or an owner. Throws AppError. */
export function requireAdmin(): User {
  const user = requireUser();
  if (!isAdminRole(user.role)) throw Errors.forbidden();
  return user;
}

/** Require an owner: the one who manages the accounts. Throws AppError. */
export function requireOwner(message = "Only an owner manages accounts"): User {
  const user = requireUser();
  if (!isOwnerRole(user.role)) throw Errors.forbidden(message);
  return user;
}

/**
 * Require an owner for what sets the installation up: its providers, their
 * keys and its models (v2.0). An admin is shown them and changes none.
 */
export function requireSetupOwner(): User {
  return requireOwner("Only an owner changes the providers and the models. An admin is shown them.");
}

/** Public-safe shape of a user (never includes secrets). */
export function publicUser(user: User) {
  const tokens = tokensOf(user);
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    /** owner, admin or user: as before 2.0. */
    role: user.role,
    /** The plan of a user: free, pro, plus or ultra. Null for an admin and an owner. */
    plan: user.role === "user" ? user.plan : null,
    /** The role as the pages say it: free, pro, plus, ultra, admin or owner. */
    tier: tierOf(user),
    status: user.status,
    twoFactorEnabled: user.twoFactorEnabled,
    /** The tokens the account may use in a calendar month. Null: it is not limited (an owner). */
    tokenLimit: tokens.limit,
    /** Whether that is the account's own allowance, not the one of its role. */
    tokenLimitIsOwn: tokens.custom,
    /** What it used this month, as it is counted: input weighs less than output. */
    tokensUsed: tokens.used,
    /** What is left of the month. Null: not limited. */
    tokensLeft: tokens.left,
    /** When the count starts again: the first of the next month, UTC. */
    tokensRenewAt: new Date(tokens.renewsAt).toISOString(),
    /** Every token the account ever used, unweighted. */
    tokensUsedInAll: tokens.total,
    createdAt: user.createdAt,
  };
}

export type PublicUser = ReturnType<typeof publicUser>;
