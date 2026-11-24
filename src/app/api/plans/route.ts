import { handle, json } from "@/lib/api";
import { publicUser, requireUser } from "@/lib/auth";
import { FEATURES, FEATURE_TEXT } from "@/lib/plan-rules";
import { getPlanSettings } from "@/lib/plans";
import { PLANS, tierOf } from "@/lib/roles";

export const dynamic = "force-dynamic";

/**
 * GET /api/plans
 *
 * The plans of this installation, as everyone is shown them: what each has
 * a month and which features, and which one this account is on.
 */
export const GET = handle(async () => {
  const user = requireUser();
  const settings = getPlanSettings();
  const me = publicUser(user);
  return json({
    tier: tierOf(user),
    tokens: { limit: me.tokenLimit, used: me.tokensUsed, left: me.tokensLeft, renewAt: me.tokensRenewAt },
    plans: PLANS.map((tier) => ({ tier, ...settings.plans[tier] })),
    features: FEATURES.map((id) => ({ id, ...FEATURE_TEXT[id] })),
  });
});
