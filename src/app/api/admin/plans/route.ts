import { z } from "zod";
import { handle, json, parseBody } from "@/lib/api";
import { requireAdmin, requireOwner } from "@/lib/auth";
import { FEATURES, FEATURE_TEXT, MAX_MONTHLY_TOKENS } from "@/lib/plan-rules";
import { getPlanSettings, plansAreChanged, resetPlanSettings, savePlanSettings } from "@/lib/plans";
import { getClientMeta } from "@/lib/request";
import { TIERS } from "@/lib/roles";

export const dynamic = "force-dynamic";

const ONLY_OWNER = "Only an owner changes what the roles have";

const planSchema = z
  .object({
    monthlyTokens: z.number().int().min(0).max(MAX_MONTHLY_TOKENS).optional(),
    features: z.array(z.string().min(1).max(40)).max(FEATURES.length).optional(),
  })
  .strict();

const bodySchema = z
  .object({
    /** What a token of input counts against the allowance, where a token of output counts as 1. */
    inputWeight: z.number().min(0).max(1).optional(),
    plans: z.object({ free: planSchema, pro: planSchema, plus: planSchema, ultra: planSchema, admin: planSchema, owner: planSchema }).partial().strict().optional(),
  })
  .strict()
  .refine((v) => v.inputWeight !== undefined || (v.plans !== undefined && Object.keys(v.plans).length > 0), { message: "Nothing to change" });

function answer() {
  const settings = getPlanSettings();
  return {
    inputWeight: settings.inputWeight,
    plans: TIERS.map((tier) => ({ tier, ...settings.plans[tier] })),
    features: FEATURES.map((id) => ({ id, ...FEATURE_TEXT[id] })),
    /** Whether an owner changed anything: otherwise it is what the app ships with. */
    changed: plansAreChanged(),
  };
}

/** What each role has: its tokens for a month and its features. Admins see it; an owner changes it. */
export const GET = handle(async () => {
  requireAdmin();
  return json(answer());
});

/**
 * An owner changes what the roles have: `{ inputWeight?, plans?: { free?: {
 * monthlyTokens?, features? }, … } }`. A feature given to a plan is given to
 * the plans above it; a plan has at least the tokens of the one below it.
 */
export const PUT = handle(async (req) => {
  const owner = requireOwner(ONLY_OWNER);
  const body = await parseBody(req, bodySchema);
  savePlanSettings(owner.id, body, getClientMeta(req));
  return json(answer());
});

/** Back to what the app ships with. */
export const DELETE = handle(async (req) => {
  const owner = requireOwner(ONLY_OWNER);
  resetPlanSettings(owner.id, getClientMeta(req));
  return json(answer());
});
