/**
 * What each role has: how many tokens a month, and which features. Pure:
 * used by the server and by the pages, and tested alone.
 *
 * - The six roles are in roles.ts (FREE, PRO, PLUS, ULTRA, ADMIN, OWNER). The
 *   first four are the plans of a user; an owner gives an account its plan.
 * - A plan has an allowance of tokens for a calendar month and a list of
 *   features. What the app ships with is DEFAULT_PLANS; an owner changes it
 *   on the Plans page, and what was changed is kept (plans.ts).
 * - It is a hierarchy: a higher plan has at least the tokens and the
 *   features of the one below it. An admin has every feature, an owner too,
 *   and an owner is not held to an allowance.
 * - Which models a plan may choose is said per model (its lowest role), on
 *   the Models page: see model-access in chat-models.ts.
 */

import { PLANS, TIERS, isTier, tierLabel, tierRank, type Plan, type Tier } from "./roles";

/** What a plan can have or not have. */
export const FEATURES = ["projects", "studio_image", "studio_voice", "studio_video", "knowledge", "automation", "api_keys"] as const;
export type Feature = (typeof FEATURES)[number];

export function isFeature(value: unknown): value is Feature {
  return typeof value === "string" && (FEATURES as readonly string[]).includes(value);
}

/** What a feature is called, and what it is, in one line each. */
export const FEATURE_TEXT: Record<Feature, { name: string; text: string }> = {
  projects: { name: "Projects", text: "Give a goal to a team of agents and get the result back" },
  studio_image: { name: "Images", text: "Make images in Creative Studio" },
  studio_voice: { name: "Voice-overs", text: "Make voice-overs in Creative Studio" },
  studio_video: { name: "Videos", text: "Make videos in Creative Studio" },
  knowledge: { name: "Knowledge base", text: "Answers that are based on your own documents" },
  automation: { name: "Schedules", text: "Run a project by itself, at the times you set" },
  api_keys: { name: "API keys", text: "Use the assistant from your own programs" },
};

export interface PlanSpec {
  /** Tokens for a calendar month. Null: not limited (an owner). */
  monthlyTokens: number | null;
  features: Feature[];
}

/** The highest allowance that can be set: far below what a number holds exactly. */
export const MAX_MONTHLY_TOKENS = 1_000_000_000_000;

const ALL: Feature[] = [...FEATURES];

/** What the app ships with. */
export const DEFAULT_PLANS: Record<Tier, PlanSpec> = {
  free: { monthlyTokens: 10_000_000, features: ["projects", "studio_image"] },
  pro: { monthlyTokens: 25_000_000, features: ["projects", "studio_image", "studio_voice", "knowledge"] },
  plus: { monthlyTokens: 50_000_000, features: ["projects", "studio_image", "studio_voice", "studio_video", "knowledge", "automation"] },
  ultra: { monthlyTokens: 100_000_000, features: ALL },
  admin: { monthlyTokens: 250_000_000, features: ALL },
  owner: { monthlyTokens: null, features: ALL },
};

/**
 * How much a token of input counts against the allowance, where a token of
 * output counts as one. Work with tools sends the same conversation again
 * with every step, so most of what a run uses is input that was sent before;
 * a provider bills it at a fraction of the output as well. Counted in full,
 * an allowance was gone half way through one long document.
 */
export const DEFAULT_INPUT_WEIGHT = 0.25;

export interface PlanSettings {
  plans: Record<Tier, PlanSpec>;
  /** 0 to 1: what a token of input counts. */
  inputWeight: number;
}

function wholeTokens(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_MONTHLY_TOKENS) return null;
  return value;
}

/** TOKEN_INPUT_WEIGHT of the environment, where it is a number from 0 to 1. */
export function inputWeightFrom(raw: string | undefined | null): number | null {
  const text = raw?.trim();
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

/** DEFAULT_TOKEN_LIMIT of the environment, as before 2.0: now what the FREE plan has a month. */
export function freeTokensFrom(raw: string | undefined | null): number | null {
  const text = raw?.trim();
  if (!text) return null;
  const value = Number(text.replace(/[_,]/g, ""));
  return wholeTokens(value);
}

export interface PlanEnv {
  DEFAULT_TOKEN_LIMIT?: string;
  TOKEN_INPUT_WEIGHT?: string;
  DEFAULT_PLAN?: string;
}

/**
 * The plan of an account that is made without one being named: someone who
 * registers, or an account an owner makes as a "user". Free, unless
 * DEFAULT_PLAN of the environment names another plan.
 */
export function defaultPlan(env: PlanEnv = process.env as PlanEnv): Plan {
  const named = env.DEFAULT_PLAN?.trim().toLowerCase();
  return PLANS.find((plan) => plan === named) ?? "free";
}

/** What the app ships with, with what the environment says about it. */
export function shippedSettings(env: PlanEnv = process.env as PlanEnv): PlanSettings {
  const plans = {} as Record<Tier, PlanSpec>;
  for (const tier of TIERS) plans[tier] = { monthlyTokens: DEFAULT_PLANS[tier].monthlyTokens, features: [...DEFAULT_PLANS[tier].features] };
  const free = freeTokensFrom(env.DEFAULT_TOKEN_LIMIT);
  if (free !== null) plans.free.monthlyTokens = free;
  return { plans, inputWeight: inputWeightFrom(env.TOKEN_INPUT_WEIGHT) ?? DEFAULT_INPUT_WEIGHT };
}

/**
 * The settings as they hold: what was saved, over what the app ships with.
 * Whatever of the saved part is not in order is left out, so that a damaged
 * row cannot take the limits away. An admin and an owner have every feature
 * and an owner no allowance, whatever was saved.
 */
export function planSettings(saved: unknown, env: PlanEnv = process.env as PlanEnv): PlanSettings {
  const out = shippedSettings(env);
  if (!saved || typeof saved !== "object") return out;
  const raw = saved as { inputWeight?: unknown; plans?: unknown };
  if (typeof raw.inputWeight === "number" && Number.isFinite(raw.inputWeight) && raw.inputWeight >= 0 && raw.inputWeight <= 1) {
    out.inputWeight = raw.inputWeight;
  }
  if (raw.plans && typeof raw.plans === "object") {
    for (const tier of TIERS) {
      if (tier === "owner") continue;
      const spec = (raw.plans as Record<string, unknown>)[tier];
      if (!spec || typeof spec !== "object") continue;
      const { monthlyTokens, features } = spec as { monthlyTokens?: unknown; features?: unknown };
      const tokens = wholeTokens(monthlyTokens);
      if (tokens !== null) out.plans[tier].monthlyTokens = tokens;
      if (tier !== "admin" && Array.isArray(features)) out.plans[tier].features = FEATURES.filter((f) => features.includes(f));
    }
  }
  return out;
}

/** What a role has. An unknown role has what FREE has. */
export function planOf(settings: PlanSettings, tier: string | null | undefined): PlanSpec {
  return settings.plans[isTier(tier) ? tier : "free"];
}

/** Whether a role has a feature. */
export function hasFeature(settings: PlanSettings, tier: string | null | undefined, feature: Feature): boolean {
  return planOf(settings, tier).features.includes(feature);
}

/** The lowest plan that has a feature. Null: no plan has it, an admin and an owner do. */
export function lowestPlanWith(settings: PlanSettings, feature: Feature): Plan | null {
  return PLANS.find((plan) => settings.plans[plan].features.includes(feature)) ?? null;
}

/** What is said to an account whose plan does not have a feature. */
export function notInPlan(settings: PlanSettings, tier: string | null | undefined, feature: Feature): string {
  const lowest = lowestPlanWith(settings, feature);
  const what = FEATURE_TEXT[feature].name;
  const from = lowest ? `part of the ${tierLabel(lowest)} plan${lowest === "ultra" ? "" : " and the plans above it"}` : "not part of a plan";
  return `${what}: ${from}. Your plan is ${tierLabel(isTier(tier) ? tier : "free")}. The owner of this installation can change it.`;
}

/** The error code of work refused because the plan does not have it. */
export const NOT_IN_PLAN_CODE = "not_in_plan";

export interface PlanInput {
  inputWeight?: number;
  plans?: Partial<Record<Tier, { monthlyTokens?: number; features?: readonly string[] }>>;
}

/**
 * What an owner saves, checked against what holds now. Resolves to the
 * settings to keep, or to why not.
 *
 * - A feature given to a plan is given to every plan above it: taking one
 *   away from a plan takes it away from the plans below.
 * - A plan has at least the tokens of the one below it.
 * - The owner's role is not changed: no allowance, every feature.
 */
export function changedSettings(current: PlanSettings, input: PlanInput): { ok: true; settings: PlanSettings } | { ok: false; error: string } {
  const next: PlanSettings = {
    inputWeight: current.inputWeight,
    plans: Object.fromEntries(TIERS.map((tier) => [tier, { monthlyTokens: current.plans[tier].monthlyTokens, features: [...current.plans[tier].features] }])) as Record<Tier, PlanSpec>,
  };
  if (input.inputWeight !== undefined) {
    if (!Number.isFinite(input.inputWeight) || input.inputWeight < 0 || input.inputWeight > 1) {
      return { ok: false, error: "What a token of input counts is a number from 0 to 1" };
    }
    next.inputWeight = Math.round(input.inputWeight * 100) / 100;
  }
  const named = input.plans ?? {};
  if (named.owner !== undefined) return { ok: false, error: "The owner's role is not changed: it has every feature, and no allowance" };
  for (const tier of TIERS) {
    const spec = named[tier];
    if (!spec) continue;
    if (spec.monthlyTokens !== undefined) {
      const tokens = wholeTokens(spec.monthlyTokens);
      if (tokens === null) return { ok: false, error: `The tokens of ${tierLabel(tier)} are a whole number from 0 to ${MAX_MONTHLY_TOKENS}` };
      next.plans[tier].monthlyTokens = tokens;
    }
    if (spec.features !== undefined) {
      if (tier === "admin") return { ok: false, error: "An admin has every feature: what is limited are the plans" };
      const unknown = spec.features.find((f) => !isFeature(f));
      if (unknown !== undefined) return { ok: false, error: `"${unknown}" is no feature of a plan` };
      next.plans[tier].features = FEATURES.filter((f) => spec.features!.includes(f));
    }
  }
  // The hierarchy of the features. Two plans the request names must agree;
  // a plan it does not name follows: it has what a named plan below it has,
  // and has not what a named plan above it has not.
  for (const below of PLANS) {
    for (const above of PLANS) {
      const low = named[below]?.features;
      const high = named[above]?.features;
      if (tierRank(below) >= tierRank(above) || low === undefined || high === undefined) continue;
      const missing = FEATURES.find((f) => low.includes(f) && !high.includes(f));
      if (missing) return { ok: false, error: `${tierLabel(above)} is above ${tierLabel(below)}: it has ${FEATURE_TEXT[missing].name.toLowerCase()} as well` };
    }
  }
  for (const plan of PLANS) {
    if (named[plan]?.features !== undefined) continue;
    const has = new Set<Feature>(next.plans[plan].features);
    for (const other of PLANS) {
      const said = named[other]?.features;
      if (said === undefined) continue;
      if (tierRank(other) < tierRank(plan)) for (const f of FEATURES) if (said.includes(f)) has.add(f);
      if (tierRank(other) > tierRank(plan)) for (const f of FEATURES) if (!said.includes(f)) has.delete(f);
    }
    next.plans[plan].features = FEATURES.filter((f) => has.has(f));
  }
  // Whatever the request left unsaid must still be a hierarchy.
  for (let i = 1; i < PLANS.length; i++) {
    const below = PLANS[i - 1]!;
    const above = PLANS[i]!;
    const missing = next.plans[below].features.find((f) => !next.plans[above].features.includes(f));
    if (missing) return { ok: false, error: `${tierLabel(above)} is above ${tierLabel(below)}: it has ${FEATURE_TEXT[missing].name.toLowerCase()} as well` };
  }
  const limited: Tier[] = ["free", "pro", "plus", "ultra", "admin"];
  for (let i = 1; i < limited.length; i++) {
    const below = limited[i - 1]!;
    const above = limited[i]!;
    if ((next.plans[above].monthlyTokens ?? 0) < (next.plans[below].monthlyTokens ?? 0)) {
      return { ok: false, error: `${tierLabel(above)} is above ${tierLabel(below)}: it cannot have fewer tokens a month` };
    }
  }
  next.plans.admin.features = [...ALL];
  next.plans.owner = { monthlyTokens: null, features: [...ALL] };
  return { ok: true, settings: next };
}
