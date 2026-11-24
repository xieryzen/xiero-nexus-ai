import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appSettings, users } from "@/db/schema";
import { audit } from "./audit";
import { Errors, PlainError } from "./errors";
import {
  NOT_IN_PLAN_CODE,
  changedSettings,
  hasFeature,
  notInPlan,
  planSettings,
  shippedSettings,
  type Feature,
  type PlanInput,
  type PlanSettings,
} from "./plan-rules";
import { TIERS, tierOf, type TieredAccount } from "./roles";

/**
 * What each role has, as the server keeps it (the rules are in
 * plan-rules.ts): one row of the settings of the installation, written when
 * an owner changes a plan. Without the row, it is what the app ships with.
 */

const KEY = "plans";

interface Held {
  settings: PlanSettings;
  /** Read again after this moment: another process may have written. */
  until: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __nexusPlans: Held | undefined;
}

/** What holds now. Asked with every request that counts tokens, so it is held for a moment. */
export function getPlanSettings(): PlanSettings {
  const held = globalThis.__nexusPlans;
  if (held && held.until > Date.now()) return held.settings;
  let saved: unknown = null;
  try {
    const row = db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, KEY)).get();
    if (row) saved = JSON.parse(row.value);
  } catch {
    // A row that cannot be read is no row: what the app ships with holds.
  }
  const settings = planSettings(saved);
  globalThis.__nexusPlans = { settings, until: Date.now() + 5_000 };
  return settings;
}

/** Whether an owner changed anything: the row is there. */
export function plansAreChanged(): boolean {
  return Boolean(db.select({ key: appSettings.key }).from(appSettings).where(eq(appSettings.key, KEY)).get());
}

interface Meta {
  ip?: string;
  userAgent?: string;
}

/** An owner changes what the roles have. Resolves to what holds from now on. */
export function savePlanSettings(actorId: string, input: PlanInput, meta: Meta = {}): PlanSettings {
  const before = getPlanSettings();
  const result = changedSettings(before, input);
  if (!result.ok) throw Errors.badRequest(result.error);
  const { settings } = result;
  const value = JSON.stringify({
    inputWeight: settings.inputWeight,
    plans: Object.fromEntries(TIERS.filter((tier) => tier !== "owner").map((tier) => [tier, settings.plans[tier]])),
  });
  db.insert(appSettings)
    .values({ key: KEY, value, updatedBy: actorId })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedBy: actorId, updatedAt: new Date() } })
    .run();
  globalThis.__nexusPlans = undefined;
  const changed: Record<string, unknown> = {};
  if (before.inputWeight !== settings.inputWeight) changed.inputWeight = settings.inputWeight;
  for (const tier of TIERS) {
    const was = before.plans[tier];
    const is = settings.plans[tier];
    if (was.monthlyTokens !== is.monthlyTokens || was.features.join() !== is.features.join()) changed[tier] = is;
  }
  audit({ actorUserId: actorId, action: "plans.update", targetType: "settings", targetId: KEY, metadata: changed, ...meta });
  return settings;
}

/** Back to what the app ships with. */
export function resetPlanSettings(actorId: string, meta: Meta = {}): PlanSettings {
  db.delete(appSettings).where(eq(appSettings.key, KEY)).run();
  globalThis.__nexusPlans = undefined;
  audit({ actorUserId: actorId, action: "plans.reset", targetType: "settings", targetId: KEY, ...meta });
  return shippedSettings();
}

/** Whether the plan of an account has a feature. */
export function accountHas(account: TieredAccount, feature: Feature): boolean {
  return hasFeature(getPlanSettings(), tierOf(account), feature);
}

/** The role and the plan of an account, read now: a run goes on long after it was started. */
function accountOf(userId: string | null | undefined): TieredAccount | undefined {
  if (!userId) return undefined;
  return db.select({ role: users.role, plan: users.plan }).from(users).where(eq(users.id, userId)).get();
}

/**
 * Whether the plan of the account with this id has a feature. Work that
 * belongs to no account (it was deleted, or the work is the installation's
 * own) is held to no plan.
 */
export function hasFeatureFor(userId: string | null | undefined, feature: Feature): boolean {
  const account = accountOf(userId);
  return !account || accountHas(account, feature);
}

/** As assertFeature, for the account with this id. */
export function assertFeatureFor(userId: string | null | undefined, feature: Feature): void {
  const account = accountOf(userId);
  if (account) assertFeature(account, feature);
}

/** Refuses what the plan of an account does not have: 403, with which plan has it. */
export function assertFeature(account: TieredAccount, feature: Feature): void {
  const settings = getPlanSettings();
  const tier = tierOf(account);
  // Said as it is to everyone: it speaks of plans, not of how the installation is set up.
  if (!hasFeature(settings, tier, feature)) throw new PlainError(403, NOT_IN_PLAN_CODE, notInPlan(settings, tier, feature));
}
