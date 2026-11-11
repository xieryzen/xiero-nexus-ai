import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getAgentStats, getRecentAgentRuns } from "@/lib/stats";
import { formatNumber, formatRelative } from "@/lib/format";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Observability" };

export default function ObservabilityPage() {
  const user = getCurrentUser();
  if (user?.role !== "admin") redirect("/dashboard");

  const stats = getAgentStats();
  const runs = getRecentAgentRuns(25);

  return (
    <div className="space-y-6">
      <PageHeader title="Observability" description="Agent execution metrics from orchestration runs." />

      <Card title="Agent performance" description="Aggregated across all project runs.">
        {stats.length === 0 ? (
          <EmptyState title="No agent runs yet" description="Run a project in the AI Manager to populate metrics." />
        ) : (
          <div className="-m-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-ink-3">
                  <th className="px-5 py-2.5 font-medium">Agent</th>
                  <th className="px-5 py-2.5 text-right font-medium">Runs</th>
                  <th className="px-5 py-2.5 text-right font-medium">OK</th>
                  <th className="px-5 py-2.5 text-right font-medium">Errors</th>
                  <th className="px-5 py-2.5 text-right font-medium">Avg latency</th>
                  <th className="px-5 py-2.5 text-right font-medium">Tokens</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {stats.map((s) => (
                  <tr key={s.agentId ?? "unknown"}>
                    <td className="px-5 py-2.5">
                      <span className="text-ink">{s.name ?? "(removed agent)"}</span>
                      {s.role && <span className="ml-2 text-xs text-ink-3">{s.role}</span>}
                    </td>
                    <td className="px-5 py-2.5 text-right text-ink-2">{formatNumber(s.runs)}</td>
                    <td className="px-5 py-2.5 text-right text-ok">{formatNumber(s.ok)}</td>
                    <td className="px-5 py-2.5 text-right text-danger">{formatNumber(s.errors)}</td>
                    <td className="px-5 py-2.5 text-right text-ink-2">{formatNumber(s.avgLatencyMs)} ms</td>
                    <td className="px-5 py-2.5 text-right text-ink-2">{formatNumber(s.tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Recent agent runs">
        {runs.length === 0 ? (
          <EmptyState title="No runs yet" />
        ) : (
          <ul className="divide-y divide-line">
            {runs.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <div className="min-w-0">
                  <span className="text-ink">{r.agentName ?? "agent"}</span>
                  <span className="ml-2 text-xs text-ink-3">{r.projectTitle ?? "—"}</span>
                  {r.error && <span className="ml-2 text-xs text-danger">· {r.error.slice(0, 60)}</span>}
                </div>
                <span className="flex shrink-0 items-center gap-2">
                  {r.latencyMs != null && <span className="text-xs text-ink-3">{r.latencyMs} ms</span>}
                  <Badge tone={r.status === "ok" ? "ok" : "danger"}>{r.status}</Badge>
                  <span className="text-xs text-ink-3">{formatRelative(r.createdAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
