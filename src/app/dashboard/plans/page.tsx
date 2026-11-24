import { requirePageUser } from "@/lib/auth";
import { FEATURES, FEATURE_TEXT } from "@/lib/plan-rules";
import { getPlanSettings, plansAreChanged } from "@/lib/plans";
import { TIERS, isAdminRole, isOwnerRole, tierLabel, tierOf } from "@/lib/roles";
import { tokensOf } from "@/lib/tokens";
import { PageHeader } from "@/components/ui";
import { PlansClient } from "@/components/plans/plans-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Plans" };

/**
 * The plans: what each role has in a month, and which features. Everyone is
 * shown them, with the one they are on; an owner changes them here.
 */
export default function PlansPage() {
  const user = requirePageUser();
  const settings = getPlanSettings();
  const tier = tierOf(user);
  const owner = isOwnerRole(user.role);
  const tokens = tokensOf(user);
  return (
    <div>
      <PageHeader
        title="Plans"
        description={
          owner
            ? "What each role has: its tokens for a month, and its features. You give an account its role under Users & roles."
            : isAdminRole(user.role)
              ? "What each role has. The owner of this installation sets the plans, and gives each account its role."
              : `Your plan is ${tierLabel(tier)}. The owner of this installation gives each account its plan.`
        }
      />
      <PlansClient
        tier={tier}
        canManage={owner}
        changed={plansAreChanged()}
        inputWeight={settings.inputWeight}
        plans={TIERS.map((t) => ({ tier: t, monthlyTokens: settings.plans[t].monthlyTokens, features: settings.plans[t].features }))}
        features={FEATURES.map((id) => ({ id, ...FEATURE_TEXT[id] }))}
        own={{ limit: tokens.limit, used: tokens.used, left: tokens.left, custom: tokens.custom, renewsAt: tokens.renewsAt }}
      />
    </div>
  );
}
