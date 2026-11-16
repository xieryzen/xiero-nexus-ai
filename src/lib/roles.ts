/**
 * The roles of an account, and who may change whose account. Pure: used by
 * the server and by the pages, and tested alone.
 *
 *   owner  everything an administrator does, and the accounts: making them,
 *          their roles, names, addresses and passwords, and deleting them.
 *   admin  providers, models, agents, teams, workflows, skills, the audit
 *          log, everyone's projects and usage. Sees the accounts, and
 *          changes none.
 *   user   their own projects, chats, media and keys.
 */

export const ROLES = ["owner", "admin", "user"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** An administrator. An owner is one too. */
export function isAdminRole(role: string | null | undefined): boolean {
  return role === "admin" || role === "owner";
}

export function isOwnerRole(role: string | null | undefined): boolean {
  return role === "owner";
}

/** What a role is called on a page. */
export function roleLabel(role: string | null | undefined): string {
  return role === "owner" ? "Owner" : role === "admin" ? "Administrator" : "User";
}

// ─── Changing an account ─────────────────────────────────────────────────────

export interface AccountOf {
  id: string;
  role: string;
  status: string;
}

export interface AccountChange {
  role?: Role;
  status?: "active" | "disabled";
  /** The account is deleted. */
  remove?: boolean;
}

/**
 * Why this change to an account may not be made, or null when it may.
 * `otherActiveOwners` is how many owners that can sign in there are besides
 * the account that is changed.
 *
 * - Only an owner changes accounts.
 * - Nobody changes their own role or status here, or deletes themselves: an
 *   owner who demoted or disabled themselves by a slip could not undo it.
 * - There is always an owner who can sign in.
 */
export function whyNot(
  actor: AccountOf,
  target: AccountOf,
  change: AccountChange,
  otherActiveOwners: number,
): string | null {
  if (!isOwnerRole(actor.role)) return "Only an owner manages accounts";
  const self = actor.id === target.id;
  if (self && change.remove) return "You cannot delete your own account";
  if (self && (change.role !== undefined || change.status !== undefined)) {
    return "You cannot change your own role or status";
  }
  const losesOwner =
    isOwnerRole(target.role) &&
    target.status === "active" &&
    (change.remove === true ||
      change.status === "disabled" ||
      (change.role !== undefined && !isOwnerRole(change.role)));
  if (losesOwner && otherActiveOwners < 1) return "At least one active owner must remain";
  return null;
}
