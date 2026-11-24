import Link from "next/link";
import { redirect } from "next/navigation";
import { requirePageUser } from "@/lib/auth";
import { adminPagesFor } from "@/lib/admin-nav";
import { formatCompact, formatNumber } from "@/lib/format";
import { isAdminRole, isOwnerRole } from "@/lib/roles";
import { getOverviewStats, getRecentAudit } from "@/lib/stats";
import { Icon } from "@/components/icons";
import { RelativeTime } from "@/components/time";
import { Alert, Badge, Card, EmptyState, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin console" };

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-5">
      <p className="text-xs text-ink-3">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-ink">{value}</p>
      {sub && <p className="mt-1 text-xs text-ink-2">{sub}</p>}
    </div>
  );
}

/**
 * The admin console: the installation at a glance, and the way to each part
 * of the admin area. An owner manages all of it. An admin is shown a limited
 * part: what holds keys, costs money or changes accounts is the owner's.
 */
export default function AdminConsolePage() {
  const user = requirePageUser();
  if (!isAdminRole(user.role)) redirect("/dashboard");
  const owner = isOwnerRole(user.role);
  const stats = getOverviewStats();
  const recent = getRecentAudit(10);
  const pages = adminPagesFor(user.role).filter((page) => page.area !== "overview");

  return (
    <div id="admin-console">
      <PageHeader
        title="Admin console"
        description={owner ? "This installation: its accounts, its plans, and where its models come from." : "This installation, as an admin is shown it."}
      />

      {!owner && (
        <div className="mb-6" data-testid="admin-limited">
          <Alert tone="neutral">
            Your role is Admin. You manage skills, agents, teams and workflows, and you can look at the rest. Providers and their keys, models, plans
            and accounts are changed by the owner only.
          </Alert>
        </div>
      )}

      {owner && stats.providers.total === 0 && (
        <div className="mb-6">
          <Card title="Get started" description="Your instance has no providers yet.">
            <p className="text-sm text-ink-2">
              Connect your first AI provider — add its Base URL and API key, then discover or register models. Once a model is enabled you can start a
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
        <StatTile label="Providers" value={`${stats.providers.enabled}`} sub={`${stats.providers.total} configured`} />
        <StatTile label="Models" value={`${stats.models.enabled}`} sub={`${stats.models.total} in catalog`} />
        <StatTile label="Tokens today" value={formatCompact(stats.tokensToday)} sub={`${formatCompact(stats.tokensMonth)} this month`} />
        <StatTile label="Requests" value={formatNumber(stats.requestsTotal)} sub={stats.errors24h > 0 ? `${stats.errors24h} errors in 24h` : "all time"} />
      </div>

      <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="admin-pages">
        {pages.map((page) => (
          <li key={page.href}>
            <Link href={page.href} className="card flex h-full items-start gap-3 p-4 transition hover:border-line-strong">
              <span className="mt-0.5 text-accent-ink">
                <Icon name={page.icon} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="font-medium text-ink">{page.label}</span>
                  {page.access === "view" && <Badge tone="neutral">to look at</Badge>}
                </span>
                <span className="mt-0.5 block text-sm text-ink-2">{page.text}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>

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
                  <RelativeTime at={new Date(ev.createdAt).getTime()} className="shrink-0 text-xs text-ink-3" />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
