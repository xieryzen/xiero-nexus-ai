import { getCurrentUser } from "@/lib/auth";
import { getUsageSummary } from "@/lib/stats";
import { formatCompact, formatCost, formatNumber } from "@/lib/format";
import { RelativeTime } from "@/components/time";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { usageFor } from "@/lib/for-viewer";
import Link from "next/link";
import { isAdminRole, seesSetup, tierLine, tierOf } from "@/lib/roles";
import { getPlanSettings } from "@/lib/plans";
import { tokensOf } from "@/lib/tokens";
import { TokenMeter } from "@/components/token-meter";

export const dynamic = "force-dynamic";
export const metadata = { title: "Usage & Costs" };

export default function UsagePage() {
  const user = getCurrentUser();
  const isAdmin = isAdminRole(user?.role);
  // Which model a request went to and what it cost are for those who are
  // shown the setup; a user sees what their work used.
  const sees = seesSetup(user?.role);
  const summary = usageFor(user?.role, getUsageSummary(isAdmin ? null : user!.id));

  const tiles = [
    { label: "Tokens today", value: formatCompact(summary.today.tokens) },
    { label: "Tokens this month", value: formatCompact(summary.month.tokens) },
    { label: "Requests (all time)", value: formatNumber(summary.totals.requests) },
    sees
      ? { label: "Est. cost this month", value: formatCost(summary.month.cost) }
      : { label: "Tokens (all time)", value: formatCompact(summary.totals.tokens) },
  ];

  return (
    <div>
      <PageHeader
        title={sees ? "Usage & Costs" : "Usage"}
        description={isAdmin ? "Platform-wide usage across all users." : "What your work used."}
      />

      {/* What an account has for this month: its own, also for an admin who looks at everyone's usage below. */}
      {user && (
        <div className="mb-6" id="own-overview">
          <Card
            title={isAdmin ? "Your own tokens" : "Your tokens"}
            description={`${tierLine(tierOf(user))}${isAdmin ? "" : ": what your work may use, and what it has used."}`}
            actions={
              <Link href="/dashboard/plans" className="btn-ghost px-3 py-1.5 text-xs">
                {isAdmin ? "Plans" : "See the plans"}
              </Link>
            }
          >
            <TokenMeter tokens={tokensOf(user)} inputPercent={Math.round(getPlanSettings().inputWeight * 100)} />
          </Card>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="card p-5">
            <p className="text-xs uppercase tracking-wider text-ink-3">{t.label}</p>
            <p className="mt-2 text-2xl font-semibold tracking-tight text-ink">{t.value}</p>
          </div>
        ))}
      </div>

      {sees && (
        <p className="mt-2 text-xs text-ink-3">
          Costs are estimates derived from the price metadata you set on each model,
          not authoritative provider billing.
        </p>
      )}

      <div className="mt-6">
        <Card title="Recent activity" description={sees ? "Most recent requests through the gateway" : "Your most recent requests"}>
          {summary.recent.length === 0 ? (
            <EmptyState title="No usage recorded yet" />
          ) : (
            <div className="-m-5 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-ink-3">
                    <th className="px-5 py-2.5 font-medium">When</th>
                    {sees && <th className="px-5 py-2.5 font-medium">Model</th>}
                    <th className="px-5 py-2.5 font-medium">Kind</th>
                    <th className="px-5 py-2.5 text-right font-medium">Tokens</th>
                    {sees && <th className="px-5 py-2.5 text-right font-medium">Est. cost</th>}
                    <th className="px-5 py-2.5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {summary.recent.map((r) => (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap px-5 py-2.5 text-ink-3"><RelativeTime at={new Date(r.createdAt).getTime()} /></td>
                      {sees && (
                        <td className="px-5 py-2.5">
                          <span className="mono text-ink-2">{r.modelId ?? "—"}</span>
                          {r.providerName && <span className="ml-2 text-xs text-ink-3">{r.providerName}</span>}
                        </td>
                      )}
                      <td className="px-5 py-2.5 text-ink-2">{r.kind}</td>
                      <td className="px-5 py-2.5 text-right text-ink-2">
                        {/* An image or a video is not measured in tokens. */}
                        {(r.kind === "image" || r.kind === "video") && r.totalTokens === 0 ? "—" : formatNumber(r.totalTokens)}
                      </td>
                      {sees && <td className="px-5 py-2.5 text-right text-ink-2">{formatCost(r.estimatedCost)}</td>}
                      <td className="px-5 py-2.5">
                        <Badge tone={r.status === "ok" ? "ok" : "danger"}>{r.status}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
