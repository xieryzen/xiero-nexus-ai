import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { getOverviewStats, getRecentAudit } from "@/lib/stats";
import { formatCompact, formatNumber, formatRelative } from "@/lib/format";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Overview" };

function StatTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="card p-5">
      <p className="text-xs uppercase tracking-wider text-ink-3">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-ink">{value}</p>
      {sub && <p className="mt-1 text-xs text-ink-2">{sub}</p>}
    </div>
  );
}

export default function OverviewPage() {
  const user = getCurrentUser();
  const stats = getOverviewStats();
  const recent = user?.role === "admin" ? getRecentAudit(10) : [];

  return (
    <div>
      <PageHeader
        title={`Welcome, ${user?.username ?? ""}`}
        description="A snapshot of your Nexus control plane."
      />

      {stats.providers.total === 0 && (
        <div className="mb-6">
          <Card title="Get started" description="Your instance has no providers yet.">
            <p className="text-sm text-ink-2">
              Connect your first AI provider — add its Base URL and API key, then
              discover or register models. Once a model is enabled you can start a
              chat.
            </p>
            <div className="mt-4">
              <Link href="/dashboard/providers" className="btn-primary">
                Add a provider
              </Link>
            </div>
          </Card>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          label="Providers"
          value={`${stats.providers.enabled}`}
          sub={`${stats.providers.total} configured`}
        />
        <StatTile
          label="Models"
          value={`${stats.models.enabled}`}
          sub={`${stats.models.total} in catalog`}
        />
        <StatTile
          label="Tokens today"
          value={formatCompact(stats.tokensToday)}
          sub={`${formatCompact(stats.tokensMonth)} this month`}
        />
        <StatTile
          label="Requests"
          value={formatNumber(stats.requestsTotal)}
          sub={
            stats.errors24h > 0 ? `${stats.errors24h} errors in 24h` : "all time"
          }
        />
      </div>

      {user?.role === "admin" && (
        <div className="mt-6">
          <Card title="Recent activity" description="Latest administrative events">
            {recent.length === 0 ? (
              <EmptyState title="No activity yet" />
            ) : (
              <ul className="divide-y divide-line">
                {recent.map((ev) => (
                  <li key={ev.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <div className="flex min-w-0 items-center gap-3">
                      <Badge tone="neutral">{ev.action}</Badge>
                      <span className="truncate text-ink-2">
                        {ev.actorUsername ?? "system"}
                        {ev.targetType ? ` · ${ev.targetType}` : ""}
                      </span>
                    </div>
                    <span className="shrink-0 text-xs text-ink-3">
                      {formatRelative(ev.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
