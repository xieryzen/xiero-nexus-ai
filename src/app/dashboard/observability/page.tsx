import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { serverStatus } from "@/lib/server-status";
import { getAgentStats, getRecentAgentRuns } from "@/lib/stats";
import { formatNumber } from "@/lib/format";
import { RelativeTime } from "@/components/time";
import { Badge, Card, EmptyState, PageHeader, StatusDot } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Observability" };

function Item({
  label,
  tone,
  value,
  note,
}: {
  label: string;
  tone: "ok" | "warn" | "danger" | "neutral";
  value: string;
  note?: string;
}) {
  return (
    <div className="rounded-md border border-line bg-surface-2/40 px-3.5 py-3" data-status={label} data-state={value}>
      <p className="text-xs text-ink-3">{label}</p>
      <p className="mt-1 flex items-center gap-2 text-sm font-medium text-ink">
        <StatusDot tone={tone} />
        {value}
      </p>
      {note && <p className="mt-1 text-xs text-ink-3">{note}</p>}
    </div>
  );
}

export default async function ObservabilityPage() {
  const user = getCurrentUser();
  if (user?.role !== "admin") redirect("/dashboard");

  const stats = getAgentStats();
  const runs = getRecentAgentRuns(25);
  const server = await serverStatus();
  const { worker, queue, ffmpeg, tools } = server;
  // The worker does a round every few seconds: a long silence means it is stuck.
  const workerLate = worker.lastRoundAgoMs !== null && worker.lastRoundAgoMs > 60_000;
  const waiting = [
    queue.runsRunning > 0 ? `${queue.runsRunning} ${queue.runsRunning === 1 ? "run" : "runs"} in progress` : "",
    queue.runsQueued > 0 ? `${queue.runsQueued} waiting to start` : "",
    queue.videosPending > 0 ? `${queue.videosPending} ${queue.videosPending === 1 ? "video" : "videos"} at providers` : "",
    queue.rendersPending > 0 ? `${queue.rendersPending} being joined` : "",
    queue.jobsQueued > 0 ? `${queue.jobsQueued} background ${queue.jobsQueued === 1 ? "job" : "jobs"}` : "",
    queue.webhooksPending > 0 ? `${queue.webhooksPending} webhook ${queue.webhooksPending === 1 ? "delivery" : "deliveries"}` : "",
  ].filter(Boolean);

  return (
    <div className="space-y-6">
      <PageHeader title="Observability" description="What the server is set up for, what its background worker is doing, and how the agents performed." />

      <Card title="Server" description="Background work and the optional parts. Each of them is set up with environment variables; the README lists them.">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Item
            label="Background worker"
            tone={!worker.enabled ? "warn" : worker.problems.length > 0 || workerLate ? "danger" : worker.started ? "ok" : "warn"}
            value={
              !worker.enabled
                ? "Switched off"
                : !worker.started
                  ? "Not started yet"
                  : workerLate
                    ? "Not responding"
                    : "Running"
            }
            note={
              !worker.enabled
                ? "NEXUS_WORKER=0: this process starts no runs, schedules or background jobs. Another process on the same database has to."
                : worker.problems.length > 0
                  ? worker.problems.join(" · ")
                  : `Runs projects (up to ${worker.runConcurrency} at once), schedules, videos, joins, embeddings and webhooks.`
            }
          />
          <Item
            label="Waiting or in progress"
            tone={queue.jobsFailed > 0 ? "warn" : "neutral"}
            value={waiting.length > 0 ? waiting.join(", ") : "Nothing"}
            note={
              `${queue.schedulesEnabled} ${queue.schedulesEnabled === 1 ? "schedule is" : "schedules are"} switched on.` +
              (queue.jobsFailed > 0 ? ` ${queue.jobsFailed} background ${queue.jobsFailed === 1 ? "job" : "jobs"} failed in the last week.` : "")
            }
          />
          <Item
            label="Joining clips (ffmpeg)"
            tone={ffmpeg.available && ffmpeg.h264 ? (ffmpeg.subtitles ? "ok" : "warn") : "warn"}
            value={
              !ffmpeg.available
                ? "Not installed"
                : !ffmpeg.h264
                  ? `ffmpeg ${ffmpeg.version ?? ""} without H.264`
                  : `ffmpeg ${ffmpeg.version ?? ""}`.trim()
            }
            note={
              !ffmpeg.available
                ? "Install ffmpeg or set FFMPEG_PATH. Until then clips stay separate files; everything else works."
                : !ffmpeg.h264
                  ? "This build has no libx264, so clips cannot be joined."
                  : ffmpeg.subtitles
                    ? "Can join clips and burn subtitles in."
                    : "Can join clips. It cannot draw subtitles (built without libass)."
            }
          />
          <Item
            label="Running commands (sandbox)"
            tone={tools.sandbox ? "ok" : "neutral"}
            value={tools.sandbox ? "Configured" : "Not configured"}
            note={
              tools.sandbox
                ? "Agents with the “Run commands” tool run them in the sandbox runner."
                : "Set SANDBOX_URL to an isolated runner. Until then agents do not get the “Run commands” tool."
            }
          />
          <Item
            label="Web search"
            tone={tools.search ? "ok" : "neutral"}
            value={tools.search ?? "Not configured"}
            note={
              tools.search
                ? "Agents with the “Search the web” tool search through it."
                : "Set SEARCH_PROVIDER (brave, tavily or searxng) and its key. Until then agents do not get the “Search the web” tool."
            }
          />
          <Item
            label="Addresses agents may reach"
            tone="neutral"
            value={tools.hostsRestricted ? "Only the listed hosts" : "Any public address"}
            note={
              tools.hostsRestricted
                ? "AGENT_HTTP_ALLOWED_HOSTS is set. Private network addresses are refused unless listed in AGENT_HTTP_PRIVATE_HOSTS."
                : "Private network addresses are always refused. AGENT_HTTP_ALLOWED_HOSTS narrows it to hosts you list."
            }
          />
        </div>
      </Card>

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
                  <RelativeTime at={new Date(r.createdAt).getTime()} className="text-xs text-ink-3" />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
