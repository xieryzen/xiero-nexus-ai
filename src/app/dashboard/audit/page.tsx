import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getRecentAudit } from "@/lib/stats";
import { formatDateTime } from "@/lib/format";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Audit Log" };

export default function AuditPage() {
  const user = getCurrentUser();
  if (user?.role !== "admin") redirect("/dashboard");

  const events = getRecentAudit(200);

  return (
    <div>
      <PageHeader title="Audit Log" description="Administrative and security events. Secrets are never recorded." />
      <Card className="overflow-hidden">
        {events.length === 0 ? (
          <EmptyState title="No events yet" />
        ) : (
          <div className="-m-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-ink-3">
                  <th className="px-5 py-2.5 font-medium">Time</th>
                  <th className="px-5 py-2.5 font-medium">Actor</th>
                  <th className="px-5 py-2.5 font-medium">Action</th>
                  <th className="px-5 py-2.5 font-medium">Target</th>
                  <th className="px-5 py-2.5 font-medium">IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {events.map((e) => (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap px-5 py-2.5 text-ink-3">{formatDateTime(e.createdAt)}</td>
                    <td className="px-5 py-2.5 text-ink-2">{e.actorUsername ?? "system"}</td>
                    <td className="px-5 py-2.5">
                      <Badge tone="neutral">{e.action}</Badge>
                    </td>
                    <td className="px-5 py-2.5 text-ink-3">
                      {e.targetType ? <span className="mono">{e.targetType}</span> : "—"}
                    </td>
                    <td className="px-5 py-2.5 mono text-xs text-ink-3">{e.ip ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
