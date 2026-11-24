import Link from "next/link";
import { hasFeature, notInPlan, type Feature } from "@/lib/plan-rules";
import { getPlanSettings } from "@/lib/plans";
import { tierOf, type TieredAccount } from "@/lib/roles";
import { Alert } from "@/components/ui";

/**
 * On a page whose feature the plan of the account does not have: that it is
 * so, which plan has it, and the way to the plans. Nothing where the plan
 * has it. What was made before stays to be looked at; making more is refused
 * by the server with the same words.
 */
export function PlanNotice({ account, feature }: { account: TieredAccount; feature: Feature }) {
  const settings = getPlanSettings();
  const tier = tierOf(account);
  if (hasFeature(settings, tier, feature)) return null;
  return (
    <div className="mb-6" data-testid="not-in-plan" data-feature={feature}>
      <Alert tone="neutral">
        {notInPlan(settings, tier, feature)}{" "}
        <Link href="/dashboard/plans" className="font-medium text-accent-ink hover:underline">
          See the plans
        </Link>
      </Alert>
    </div>
  );
}
