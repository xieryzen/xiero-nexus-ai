import "server-only";
import { and, eq, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { recoveryCodes, users, type User } from "@/db/schema";
import { audit } from "./audit";
import { hashPassword, verifyPassword } from "./crypto";
import { Errors } from "./errors";
import { rateLimit } from "./ratelimit";
import { PLANS, ROLES, accountOfTier, isOwnerRole, tierOf, tierOfInput, whyNot } from "./roles";
import { defaultPlan } from "./plan-rules";
import { MAX_TOKEN_LIMIT } from "./token-rules";
import { destroyAllSessions } from "./session";
import { emailSchema, passwordSchema, usernameSchema } from "./validation";

/**
 * The accounts of the installation, as their owner manages them, and a
 * person's own account. Every change is in the audit log; a password never
 * is, and neither is it in an answer.
 */

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

// ─── What may be sent ────────────────────────────────────────────────────────

/** The tokens an account may use in a month, as its own allowance: a whole number from 0. */
export const tokenLimitSchema = z
  .number({ invalid_type_error: "The token limit is a whole number" })
  .int("The token limit is a whole number")
  .min(0, "The token limit cannot be below 0")
  .max(MAX_TOKEN_LIMIT, `The token limit can be at most ${MAX_TOKEN_LIMIT}`);

/**
 * The role of an account: one of the six of the pages (free, pro, plus,
 * ultra, admin, owner), or "user" as before 2.0, which is the plan the
 * request names beside it, or FREE.
 */
export const roleSchema = z.enum([...ROLES, ...PLANS]);

export const createAccountSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  password: passwordSchema,
  /** Without one, FREE. */
  role: roleSchema.optional(),
  /** The plan of a user, where the role is given as "user" or not at all. */
  plan: z.enum(PLANS).optional(),
  /** Its own allowance for a month. Without one, the allowance of its role. */
  tokenLimit: tokenLimitSchema.nullable().optional(),
});

export const updateAccountSchema = z
  .object({
    username: usernameSchema.optional(),
    email: emailSchema.optional(),
    password: passwordSchema.optional(),
    role: roleSchema.optional(),
    plan: z.enum(PLANS).optional(),
    status: z.enum(["active", "disabled"]).optional(),
    /** Its own allowance for a month; null: the allowance of its role again. What it has used stays counted. */
    tokenLimit: tokenLimitSchema.nullable().optional(),
    /** Switch two-factor sign-in off for someone who lost their authenticator. */
    resetTwoFactor: z.literal(true).optional(),
    /** End every session of the account. */
    signOut: z.literal(true).optional(),
  })
  .refine((v) => Object.values(v).some((value) => value !== undefined), { message: "Nothing to update" });

export const updateOwnAccountSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password"),
    username: usernameSchema.optional(),
    email: emailSchema.optional(),
    newPassword: passwordSchema.optional(),
  })
  .refine((v) => v.username !== undefined || v.email !== undefined || v.newPassword !== undefined, {
    message: "Nothing to update",
  });

export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;
export type UpdateOwnAccountInput = z.infer<typeof updateOwnAccountSchema>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Fails when another account has this username or this email. */
function assertFree(username: string | undefined, email: string | undefined, exceptId?: string): void {
  const wanted = [
    ...(username !== undefined ? [eq(users.username, username)] : []),
    ...(email !== undefined ? [eq(users.email, email)] : []),
  ];
  if (wanted.length === 0) return;
  const match = or(...wanted);
  const clash = db
    .select({ email: users.email, username: users.username })
    .from(users)
    .where(exceptId ? and(match, ne(users.id, exceptId)) : match)
    .get();
  if (!clash) return;
  throw Errors.conflict(
    email !== undefined && clash.email === email ? "An account with that email already exists" : "That username is taken",
  );
}

/** How many owners that can sign in there are besides this account. */
function otherActiveOwners(exceptId: string): number {
  return (
    db
      .select({ v: sql<number>`count(*)` })
      .from(users)
      .where(and(eq(users.role, "owner"), eq(users.status, "active"), ne(users.id, exceptId)))
      .get()?.v ?? 0
  );
}

function load(id: string): User {
  const target = db.select().from(users).where(eq(users.id, id)).get();
  if (!target) throw Errors.notFound("User not found");
  return target;
}

// ─── An owner and the accounts ───────────────────────────────────────────────

export function createAccount(actor: User, input: CreateAccountInput, meta: RequestMeta = {}): User {
  assertFree(input.username, input.email);
  // "user", or no role at all: a user with the plan new accounts have (DEFAULT_PLAN), unless one is named.
  const unnamed = (input.role === undefined || input.role === "user") && input.plan === undefined;
  const kept = accountOfTier(unnamed ? defaultPlan() : (tierOfInput(input.role, input.plan) ?? defaultPlan()));
  if (input.tokenLimit !== undefined && input.tokenLimit !== null && isOwnerRole(kept.role)) {
    throw Errors.badRequest("An owner is not held to a token limit: there is none to set");
  }
  const created = db
    .insert(users)
    .values({
      username: input.username,
      email: input.email,
      passwordHash: hashPassword(input.password),
      role: kept.role,
      plan: kept.plan ?? "free",
      status: "active",
      tokenAllowance: input.tokenLimit ?? null,
    })
    .returning()
    .get();
  audit({
    actorUserId: actor.id,
    action: "admin.user.create",
    targetType: "user",
    targetId: created.id,
    metadata: { username: created.username, role: tierOf(created), ...(created.tokenAllowance !== null ? { tokenLimit: created.tokenAllowance } : {}) },
    ...meta,
  });
  return created;
}

export function updateAccount(actor: User, id: string, input: UpdateAccountInput, meta: RequestMeta = {}): User {
  const target = load(id);
  if (actor.id === target.id) {
    // Their own name, address and password need their current password: Settings asks for it.
    throw Errors.badRequest(
      input.role !== undefined || input.status !== undefined
        ? "You cannot change your own role or status"
        : "Change your own account under Settings",
    );
  }
  // The role as the request names it: one of the six, or "user" with a plan.
  // A plan alone changes the plan of a user, and nothing of an admin or an owner.
  const named =
    input.role === undefined && input.plan !== undefined && target.role !== "user"
      ? undefined
      : input.role === "user" && input.plan === undefined
        ? // "user" as before 2.0: a user it stays, with the plan it has; an admin or an owner becomes a user with the plan new accounts have.
          target.role === "user"
          ? tierOf(target)
          : defaultPlan()
        : tierOfInput(input.role, input.plan);
  if (input.role === undefined && input.plan !== undefined && named === undefined) {
    throw Errors.badRequest("A plan is what a user has. Give the account a role of a user first: free, pro, plus or ultra.");
  }
  const kept = named === undefined ? undefined : accountOfTier(named);
  const refused = whyNot(actor, target, { role: kept?.role, status: input.status }, otherActiveOwners(target.id));
  if (refused) throw Errors.badRequest(refused);
  if (input.tokenLimit !== undefined && input.tokenLimit !== null && isOwnerRole(kept?.role ?? target.role)) {
    throw Errors.badRequest("An owner is not held to a token limit: there is none to set");
  }

  const username = input.username !== undefined && input.username !== target.username ? input.username : undefined;
  const email = input.email !== undefined && input.email !== target.email ? input.email : undefined;
  assertFree(username, email, target.id);

  const patch: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
  const changed: string[] = [];
  if (username !== undefined) {
    patch.username = username;
    changed.push("username");
  }
  if (email !== undefined) {
    patch.email = email;
    changed.push("email");
  }
  if (kept !== undefined && named !== tierOf(target)) {
    patch.role = kept.role;
    if (kept.plan !== undefined) patch.plan = kept.plan;
    changed.push("role");
  }
  if (input.status !== undefined && input.status !== target.status) {
    patch.status = input.status;
    changed.push("status");
  }
  if (input.password !== undefined) {
    patch.passwordHash = hashPassword(input.password);
    changed.push("password");
  }
  if (input.tokenLimit !== undefined && input.tokenLimit !== target.tokenAllowance) {
    patch.tokenAllowance = input.tokenLimit;
    changed.push("tokenLimit");
  }
  // An owner has no allowance: one that was the account's own goes with the role.
  if (kept !== undefined && isOwnerRole(kept.role) && target.tokenAllowance !== null && input.tokenLimit === undefined) {
    patch.tokenAllowance = null;
  }
  const resetTwoFactor = input.resetTwoFactor === true && (target.twoFactorEnabled || target.twoFactorSecret !== null);
  if (resetTwoFactor) {
    patch.twoFactorEnabled = false;
    patch.twoFactorSecret = null;
    patch.twoFactorConfirmedAt = null;
    changed.push("twoFactor");
  }

  db.transaction((tx) => {
    tx.update(users).set(patch).where(eq(users.id, target.id)).run();
    if (resetTwoFactor) tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, target.id)).run();
  });

  // Whoever was signed in with the old password, without the second factor
  // that is gone, or to an account that is switched off, is signed out.
  const signedOut =
    input.password !== undefined || resetTwoFactor || patch.status === "disabled" || input.signOut === true;
  if (signedOut) destroyAllSessions(target.id);

  audit({
    actorUserId: actor.id,
    action: "admin.user.update",
    targetType: "user",
    targetId: target.id,
    // What changed, and the new values that are no secret. Never the password.
    metadata: {
      changed,
      ...(patch.username !== undefined ? { username: patch.username } : {}),
      ...(patch.email !== undefined ? { email: patch.email } : {}),
      ...(patch.role !== undefined ? { role: named, roleBefore: tierOf(target) } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      // The account's own allowance before and after (null: the one of its role), and what it had used by then.
      ...(changed.includes("tokenLimit")
        ? { tokenLimit: patch.tokenAllowance ?? null, tokenLimitBefore: target.tokenAllowance, tokensUsed: target.periodTokens }
        : {}),
      ...(signedOut ? { signedOut: true } : {}),
    },
    ...meta,
  });
  return load(target.id);
}

export function deleteAccount(actor: User, id: string, meta: RequestMeta = {}): void {
  const target = load(id);
  const refused = whyNot(actor, target, { remove: true }, otherActiveOwners(target.id));
  if (refused) throw Errors.badRequest(refused);
  // What the account made stays, without an owner; its sessions, keys and
  // recovery codes go with it (the foreign keys of the schema say which).
  db.delete(users).where(eq(users.id, target.id)).run();
  audit({
    actorUserId: actor.id,
    action: "admin.user.delete",
    targetType: "user",
    targetId: target.id,
    metadata: { username: target.username, email: target.email, role: tierOf(target) },
    ...meta,
  });
}

// ─── One's own account ───────────────────────────────────────────────────────

/**
 * A person changes their own username, email or password. The current
 * password is asked for every time: a session left open on a shared machine
 * is not enough to take the account over. Returns the account and whether
 * its password changed (the caller then signs the other sessions out).
 */
export function updateOwnAccount(
  user: User,
  input: UpdateOwnAccountInput,
  meta: RequestMeta = {},
): { user: User; passwordChanged: boolean } {
  if (!rateLimit(`account-update:${user.id}`, 10, 10 * 60_000).ok) throw Errors.rateLimited();
  if (!verifyPassword(input.currentPassword, user.passwordHash)) {
    audit({ actorUserId: user.id, action: "account.update.denied", targetType: "user", targetId: user.id, ...meta });
    throw Errors.unauthorized("Password is incorrect");
  }
  const username = input.username !== undefined && input.username !== user.username ? input.username : undefined;
  const email = input.email !== undefined && input.email !== user.email ? input.email : undefined;
  assertFree(username, email, user.id);

  const patch: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
  const changed: string[] = [];
  if (username !== undefined) {
    patch.username = username;
    changed.push("username");
  }
  if (email !== undefined) {
    patch.email = email;
    changed.push("email");
  }
  const passwordChanged = input.newPassword !== undefined;
  if (input.newPassword !== undefined) {
    patch.passwordHash = hashPassword(input.newPassword);
    changed.push("password");
  }
  db.update(users).set(patch).where(eq(users.id, user.id)).run();
  audit({
    actorUserId: user.id,
    action: passwordChanged ? "account.password.changed" : "account.updated",
    targetType: "user",
    targetId: user.id,
    metadata: {
      changed,
      ...(patch.username !== undefined ? { username: patch.username } : {}),
      ...(patch.email !== undefined ? { email: patch.email } : {}),
    },
    ...meta,
  });
  return { user: load(user.id), passwordChanged };
}
