import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { getOverviewStats, getRecentAudit, getUsageSummary } from "@/lib/stats";
import { formatCompact, formatNumber } from "@/lib/format";
import { kindsAvailable } from "@/lib/model-choice";
import { formatTokens, tokenSummary } from "@/lib/token-rules";
import { RelativeTime } from "@/components/time";
import { Alert, Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { isAdminRole, seesSetup } from "@/lib/roles";

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

/** What a user is shown: their own work and what it used, nothing of how the installation is set up. */
function OwnOverview({ user }: { user: NonNullable<ReturnType<typeof getCurrentUser>> }) {
  const own = getUsageSummary(user.id);
  const tokens = tokenSummary(user);
  const ready = kindsAvailable().chat;
  return (
    <div>
      <PageHeader title={`Welcome, ${user.username}`} description="Your work here, and what it used." />
      {!ready && (
        <div className="mb-6">
          <Alert tone="warn">
            This installation is not ready for work yet. An administrator has to set it up.
          </Alert>
        </div>
      )}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4" id="own-overview">
        <StatTile
          label="Tokens left"
          value={tokens.left === null ? "No limit" : formatCompact(tokens.left)}
          sub={tokens.limit === null ? `${formatTokens(tokens.used)} used` : `${formatTokens(tokens.used)} of ${formatTokens(tokens.limit)} used`}
        />
        <StatTile label="Tokens today" value={formatCompact(own.today.tokens)} />
        <StatTile label="Tokens this month" value={formatCompact(own.month.tokens)} />
        <StatTile label="Requests" value={formatNumber(own.totals.requests)} sub="all time" />
      </div>
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        {[
          { href: "/dashboard/chat", title: "Chat", text: "Ask a question, with your knowledge base when you want it." },
          { href: "/dashboard/projects", title: "AI Manager", text: "Give a goal to a team of agents and get the result back." },
          { href: "/dashboard/studio", title: "Creative Studio", text: "Make images, videos and voice-overs." },
        ].map((entry) => (
          <Link key={entry.href} href={entry.href} className="card block p-5 transition hover:border-signal/50">
            <p className="font-medium text-ink">{entry.title}</p>
            <p className="mt-1 text-sm text-ink-2">{entry.text}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}

export default function OverviewPage() {
  const user = getCurrentUser();
  // The numbers of the whole installation, its providers and its models are
  // for those who are shown the setup (roles.ts).
  if (user && !seesSetup(user.role)) return <OwnOverview user={user} />;
  const stats = getOverviewStats();
  const recent = isAdminRole(user?.role) ? getRecentAudit(10) : [];

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

      {isAdminRole(user?.role) && (
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
      )}
    </div>
  );
}
