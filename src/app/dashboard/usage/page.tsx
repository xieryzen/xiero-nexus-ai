import { getCurrentUser } from "@/lib/auth";
import { getUsageSummary } from "@/lib/stats";
import { formatCompact, formatCost, formatNumber, formatRelative } from "@/lib/format";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Usage & Costs" };

export default function UsagePage() {
  const user = getCurrentUser();
  const isAdmin = user?.role === "admin";
  const summary = getUsageSummary(isAdmin ? null : user!.id);

  const tiles = [
    { label: "Tokens today", value: formatCompact(summary.today.tokens) },
    { label: "Tokens this month", value: formatCompact(summary.month.tokens) },
    { label: "Requests (all time)", value: formatNumber(summary.totals.requests) },
    { label: "Est. cost this month", value: formatCost(summary.month.cost) },
  ];

  return (
    <div>
      <PageHeader
        title="Usage & Costs"
        description={isAdmin ? "Platform-wide usage across all users." : "Your personal usage."}
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="card p-5">
            <p className="text-xs uppercase tracking-wider text-ink-3">{t.label}</p>
            <p className="mt-2 text-2xl font-semibold tracking-tight text-ink">{t.value}</p>
          </div>
        ))}
      </div>

      <p className="mt-2 text-xs text-ink-3">
        Costs are estimates derived from the price metadata you set on each model,
        not authoritative provider billing.
      </p>

      <div className="mt-6">
        <Card title="Recent activity" description="Most recent requests through the gateway">
          {summary.recent.length === 0 ? (
            <EmptyState title="No usage recorded yet" />
          ) : (
            <div className="-m-5 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-ink-3">
                    <th className="px-5 py-2.5 font-medium">When</th>
                    <th className="px-5 py-2.5 font-medium">Model</th>
                    <th className="px-5 py-2.5 font-medium">Kind</th>
                    <th className="px-5 py-2.5 text-right font-medium">Tokens</th>
                    <th className="px-5 py-2.5 text-right font-medium">Est. cost</th>
                    <th className="px-5 py-2.5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {summary.recent.map((r) => (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap px-5 py-2.5 text-ink-3">{formatRelative(r.createdAt)}</td>
                      <td className="px-5 py-2.5">
                        <span className="mono text-ink-2">{r.modelId ?? "—"}</span>
                        {r.providerName && <span className="ml-2 text-xs text-ink-3">{r.providerName}</span>}
                      </td>
                      <td className="px-5 py-2.5 text-ink-2">{r.kind}</td>
                      <td className="px-5 py-2.5 text-right text-ink-2">
                        {/* An image or a video is not measured in tokens. */}
                        {(r.kind === "image" || r.kind === "video") && r.totalTokens === 0 ? "—" : formatNumber(r.totalTokens)}
                      </td>
                      <td className="px-5 py-2.5 text-right text-ink-2">{formatCost(r.estimatedCost)}</td>
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
