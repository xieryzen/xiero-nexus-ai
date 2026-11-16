import "server-only";
import { and, eq, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { recoveryCodes, users, type User } from "@/db/schema";
import { audit } from "./audit";
import { hashPassword, verifyPassword } from "./crypto";
import { Errors } from "./errors";
import { rateLimit } from "./ratelimit";
import { ROLES, whyNot } from "./roles";
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

export const createAccountSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  password: passwordSchema,
  /** Without one, an ordinary user. */
  role: z.enum(ROLES).optional(),
});

export const updateAccountSchema = z
  .object({
    username: usernameSchema.optional(),
    email: emailSchema.optional(),
    password: passwordSchema.optional(),
    role: z.enum(ROLES).optional(),
    status: z.enum(["active", "disabled"]).optional(),
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
  const created = db
    .insert(users)
    .values({
      username: input.username,
      email: input.email,
      passwordHash: hashPassword(input.password),
      role: input.role ?? "user",
      status: "active",
    })
    .returning()
    .get();
  audit({
    actorUserId: actor.id,
    action: "admin.user.create",
    targetType: "user",
    targetId: created.id,
    metadata: { username: created.username, role: created.role },
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
  const refused = whyNot(actor, target, { role: input.role, status: input.status }, otherActiveOwners(target.id));
  if (refused) throw Errors.badRequest(refused);

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
  if (input.role !== undefined && input.role !== target.role) {
    patch.role = input.role;
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
      ...(patch.role !== undefined ? { role: patch.role } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
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
    metadata: { username: target.username, email: target.email, role: target.role },
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
