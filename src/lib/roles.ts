/**
 * The roles of an account, and who may change whose account. Pure: used by
 * the server and by the pages, and tested alone.
 *
 * An account has one of six roles, the lowest first:
 *
 *   FREE, PRO, PLUS, ULTRA   people who use the app. They are shown their own
 *          work and nothing of the admin area. What each may do, and how many
 *          tokens a month it has, is its plan (plan-rules.ts): an owner sets
 *          the plans and gives each account its plan.
 *   ADMIN  every feature of the highest plan, and a limited part of the
 *          admin area: agents, teams, workflows and skills to manage;
 *          providers, models, plans, everyone's usage, the audit log and the
 *          accounts to look at. An admin changes no provider, no model, no
 *          plan and no account, and works only on the servers and the site
 *          accounts an owner opened to administrators: what holds keys,
 *          costs money or signs in elsewhere is the owner's.
 *   OWNER  everything.
 *
 * How it is kept: `role` is owner, admin or user, as before 2.0, and a user
 * has a `plan` (free, pro, plus, ultra). The six-valued role of the pages is
 * the two together (tierOf): a user's plan, or else the role.
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

/**
 * Who is shown how the installation is set up: its providers and models and
 * what they cost, what agents, workflows and skills are told, and what a
 * provider answered. Administrators are. A user is shown their own work and
 * what it used. In a conversation a user chooses among the models of their
 * plan (chat-models.ts); everywhere else the app chooses (model-choice.ts).
 */
export function seesSetup(role: string | null | undefined): boolean {
  return isAdminRole(role);
}

/** What a role is called on a page. */
export function roleLabel(role: string | null | undefined): string {
  return role === "owner" ? "Owner" : role === "admin" ? "Administrator" : "User";
}

// ─── The six roles of the pages ──────────────────────────────────────────────

/** What a user may have: the plans, the lowest first. */
export const PLANS = ["free", "pro", "plus", "ultra"] as const;
export type Plan = (typeof PLANS)[number];

/** The six roles, the lowest first. */
export const TIERS = ["free", "pro", "plus", "ultra", "admin", "owner"] as const;
export type Tier = (typeof TIERS)[number];

export function isPlan(value: unknown): value is Plan {
  return typeof value === "string" && (PLANS as readonly string[]).includes(value);
}

export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

export interface TieredAccount {
  role: string;
  plan?: string | null;
}

/** The role of an account as the pages say it: a user's plan, else owner or admin. */
export function tierOf(account: TieredAccount): Tier {
  if (account.role === "owner" || account.role === "admin") return account.role;
  return isPlan(account.plan) ? account.plan : "free";
}

/** Where a role stands among the six: 0 for FREE, 5 for OWNER. */
export function tierRank(tier: string | null | undefined): number {
  const index = (TIERS as readonly string[]).indexOf(tier ?? "");
  return index < 0 ? 0 : index;
}

/** Whether a role is `wanted` or above it. */
export function atLeast(tier: string | null | undefined, wanted: Tier): boolean {
  return tierRank(tier) >= tierRank(wanted);
}

const TIER_LABEL: Record<Tier, string> = { free: "Free", pro: "Pro", plus: "Plus", ultra: "Ultra", admin: "Admin", owner: "Owner" };

/** "Free", "Pro", "Plus", "Ultra", "Admin", "Owner". */
export function tierLabel(tier: string | null | undefined): string {
  return isTier(tier) ? TIER_LABEL[tier] : "Free";
}

/** Under a name, in the sidebar: "Free plan" … "Ultra plan", "Admin", "Owner". */
export function tierLine(tier: string | null | undefined): string {
  return isTier(tier) && (tier === "admin" || tier === "owner") ? TIER_LABEL[tier] : `${tierLabel(tier)} plan`;
}

/** How one of the six is kept: as a role, and for a user as a plan too. */
export function accountOfTier(tier: Tier): { role: Role; plan?: Plan } {
  if (tier === "owner" || tier === "admin") return { role: tier };
  return { role: "user", plan: tier };
}

/**
 * What a request may name as a role: one of the six, or "user" as before
 * 2.0, which is FREE unless the request names a plan as well.
 */
export function tierOfInput(role: string | undefined, plan: string | undefined): Tier | undefined {
  if (role === undefined && plan === undefined) return undefined;
  if (role === "owner" || role === "admin") return role;
  if (isPlan(role)) return role;
  // "user", or only a plan.
  return isPlan(plan) ? plan : role === "user" ? "free" : undefined;
}

// ─── The admin area ──────────────────────────────────────────────────────────

/** The parts of the admin area, in the order the menu shows them. */
export const ADMIN_AREAS = [
  "overview",
  "users",
  "plans",
  "providers",
  "models",
  "skills",
  "servers",
  "browser",
  "usage",
  "observability",
  "audit",
] as const;
export type AdminArea = (typeof ADMIN_AREAS)[number];

/**
 * What a role may do in a part of the admin area: "manage" it, only "view"
 * it, or null: it is not shown, and its pages and requests are refused.
 *
 * An owner manages everything. An admin manages the skills (and the agents,
 * teams and workflows, which have pages of their own) and looks at the rest.
 * Of the servers and the browser an admin is shown what an owner opened to
 * administrators, and registers nothing.
 */
export function adminAccess(role: string | null | undefined, area: AdminArea): "manage" | "view" | null {
  if (role === "owner") return "manage";
  if (role !== "admin") return null;
  return area === "skills" ? "manage" : "view";
}

/** Whether a role manages a part of the admin area. */
export function managesArea(role: string | null | undefined, area: AdminArea): boolean {
  return adminAccess(role, area) === "manage";
}

/** Whether a role is shown the admin area at all. */
export function seesAdminArea(role: string | null | undefined): boolean {
  return isAdminRole(role);
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
