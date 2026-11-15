"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectDTO } from "@/lib/workforce";
import type { MediaAssetDTO } from "@/lib/media/dto";
import type { TaskKind } from "@/lib/creative/prompt";
import type { RunEvent, ToolCallNote } from "@/lib/orchestrator/events";
import type { RunDTO } from "@/lib/runs";
import type { ScheduleDTO } from "@/lib/schedules";
import { apiFetch, ApiError } from "@/lib/client";
import { formatNumber } from "@/lib/format";
import { Alert, Badge, Button, Card, Input, PageHeader, cn } from "@/components/ui";
import { Icon } from "@/components/icons";
import { MediaView } from "@/components/media/media-view";
import { useMediaPolling } from "@/components/media/use-media-polling";
import { ProjectAutomation } from "./project-automation";
import { StateBadge } from "./status-badge";

interface TaskLive {
  /** The task's id. Missing only until the plan of a new run has arrived. */
  id?: string;
  seq: number;
  title: string;
  agent: string | null;
  status: string;
  /** What the task delivers: text, generated media, or a video joined from clips. */
  kind: TaskKind;
  artifact?: string | null;
  error?: string | null;
  /** What a running task is doing right now. */
  progress?: string | null;
  /** The media the task generated. */
  assets?: MediaAssetDTO[];
  /** Model calls and tool calls the task took (an agent with tools). */
  steps?: number;
  toolCalls?: number;
  /** The tool calls seen while the task ran in this page. */
  calls?: ToolCallNote[];
}

/** One recorded tool call, as the trace of a finished task shows it. */
interface TraceCall {
  id: string;
  step: number;
  name: string;
  arguments: string | null;
  result: string | null;
  isError: boolean;
  durationMs: number | null;
}

const RUNNING_STATES = new Set(["queued", "planning", "running"]);

const KIND_LABEL: Record<TaskKind, string> = {
  text: "text",
  image: "image",
  video: "video",
  audio: "voice-over",
  render: "joined video",
};

function countAssets(tasks: TaskLive[], status: MediaAssetDTO["status"]): number {
  return tasks.reduce((sum, t) => sum + (t.assets ?? []).filter((a) => a.status === status).length, 0);
}

/**
 * The assets a task card shows. A failed one is a line of text, and only when
 * it says something the task's own error does not: that is a video that
 * failed after the task had stopped waiting for it.
 */
function shownAssets(t: TaskLive): MediaAssetDTO[] {
  return (t.assets ?? []).filter(
    (a) => a.status !== "failed" || (a.error != null && !(t.error ?? "").includes(a.error)),
  );
}

export function ProjectRunner({
  project,
  agentNames,
  canRun,
  canApprove,
  initialAssets,
  imageModelLabel,
  videoModelLabel,
  speechModelLabel,
  initialSchedules,
  initialRuns,
}: {
  project: ProjectDTO;
  agentNames: Record<string, string>;
  canRun: boolean;
  canApprove: boolean;
  /** Everything this project's runs generated, oldest first. */
  initialAssets: MediaAssetDTO[];
  imageModelLabel: string | null;
  videoModelLabel: string | null;
  speechModelLabel: string | null;
  initialSchedules: ScheduleDTO[];
  initialRuns: RunDTO[];
}) {
  const [status, setStatus] = useState(project.status);
  const [tasks, setTasks] = useState<TaskLive[]>(
    project.tasks.map((t) => ({
      id: t.id,
      seq: t.seq,
      title: t.title,
      agent: t.agentId ? agentNames[t.agentId] ?? null : null,
      status: t.status,
      kind: t.kind,
      artifact: t.artifact,
      error: t.error,
      assets: initialAssets.filter((a) => a.taskId === t.id),
      steps: t.steps || undefined,
      toolCalls: t.toolCalls || undefined,
    })),
  );
  // Media of earlier runs stays in the library, but its tasks are gone.
  const [earlierMedia, setEarlierMedia] = useState(
    () => initialAssets.filter((a) => a.status !== "failed" && !project.tasks.some((t) => t.id === a.taskId)).length,
  );
  const [deliverable, setDeliverable] = useState<string | null>(project.finalDeliverable);
  const [review, setReview] = useState<string | null>(project.reviewNotes);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [budgetUsed, setBudgetUsed] = useState(project.tokensUsed);
  const [budgetLimit, setBudgetLimit] = useState(project.maxTokens);
  const [approving, setApproving] = useState(false);
  const [runInput, setRunInput] = useState("");
  const [showInput, setShowInput] = useState(false);
  // Counts the runs that ended while this page was open: the history reads again.
  const [finishedRuns, setFinishedRuns] = useState(0);
  const [traces, setTraces] = useState<Record<number, TraceCall[] | "loading" | undefined>>({});
  const [openTraces, setOpenTraces] = useState<Set<number>>(new Set());
  // One stream at a time, also when React runs an effect twice.
  const following = useRef(false);

  const upsert = useCallback((t: Partial<TaskLive> & { seq: number }) => {
    setTasks((prev) => {
      const i = prev.findIndex((x) => x.seq === t.seq);
      if (i === -1) return [...prev, { title: "", agent: null, status: "queued", kind: "text", ...t } as TaskLive].sort((a, b) => a.seq - b.seq);
      const n = [...prev];
      n[i] = { ...n[i]!, ...t };
      return n;
    });
  }, []);

  // A video can still be in progress after its task gave up waiting (or while
  // a run started elsewhere is waiting for it): keep asking until it settles.
  useMediaPolling(
    tasks.flatMap((t) => (t.assets ?? []).filter((a) => a.status === "pending").map((a) => a.id)),
    {
      onUpdate: (asset) =>
        setTasks((prev) =>
          prev.map((t) =>
            t.assets?.some((a) => a.id === asset.id)
              ? { ...t, assets: t.assets.map((a) => (a.id === asset.id ? asset : a)) }
              : t,
          ),
        ),
      onGone: (id) =>
        setTasks((prev) =>
          prev.map((t) => (t.assets?.some((a) => a.id === id) ? { ...t, assets: t.assets.filter((a) => a.id !== id) } : t)),
        ),
    },
    8000,
  );

  /** Apply one event of a run to the page. */
  const apply = useCallback((evt: RunEvent) => {
    switch (evt.type) {
      case "status":
        setStatus(evt.status);
        break;
      case "plan":
        // The plan may arrive again (after re-attaching): keep what is known.
        setTasks((prev) =>
          evt.tasks.map((t) => {
            const known = prev.find((x) => x.seq === t.seq && (!x.id || !t.id || x.id === t.id));
            return {
              ...(known ?? { status: "queued" }),
              id: t.id,
              seq: t.seq,
              title: t.title,
              agent: t.agent || null,
              kind: t.kind ?? "text",
            };
          }),
        );
        break;
      case "task":
        upsert({
          seq: evt.seq,
          title: evt.title,
          agent: evt.agent,
          status: evt.status,
          artifact: evt.artifact,
          error: evt.error,
          progress: null,
          ...(Array.isArray(evt.assets) ? { assets: evt.assets } : {}),
          ...(evt.steps ? { steps: evt.steps } : {}),
          ...(evt.toolCalls ? { toolCalls: evt.toolCalls } : {}),
        });
        break;
      case "progress":
        upsert({ seq: evt.seq, progress: evt.message });
        break;
      case "tool":
        setTasks((prev) =>
          prev.map((t) => (t.seq === evt.seq ? { ...t, calls: [...(t.calls ?? []), evt.call].slice(-40) } : t)),
        );
        break;
      case "final":
        setDeliverable(evt.deliverable);
        break;
      case "review":
        setReview(evt.notes);
        break;
      case "budget":
        setBudgetUsed(evt.used);
        setBudgetLimit(evt.limit);
        break;
      case "error":
        setError(evt.message);
        break;
      case "done":
        setStatus(evt.status);
        setFinishedRuns((n) => n + 1);
        break;
    }
  }, [upsert]);

  /** Read a stream of run events until the server ends it. */
  const consume = useCallback(
    async (res: Response) => {
      if (!res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const s = line.trim();
          // Lines that start with ":" only keep the connection open.
          if (!s.startsWith("data:")) continue;
          const payload = s.slice(5).trim();
          if (!payload) continue;
          try {
            apply(JSON.parse(payload) as RunEvent);
          } catch {
            /* ignore */
          }
        }
      }
    },
    [apply],
  );

  /**
   * Follow the run that is in progress: it is executed by the server's
   * background worker, so it can be picked up again at any time. When the
   * connection drops while the run goes on, follow it again.
   */
  const follow = useCallback(async () => {
    if (following.current) return;
    following.current = true;
    setRunning(true);
    try {
      for (let attempt = 0; attempt < 30; attempt++) {
        let ended = false;
        try {
          const res = await fetch(`/api/projects/${project.id}/events`);
          if (res.status === 401 || res.status === 403 || res.status === 404) break;
          if (res.ok) {
            await consume(res);
            // The stream ends with the run, or because the connection was cut.
            const fresh = await apiFetch<{ project: ProjectDTO }>(`/api/projects/${project.id}`);
            ended = !RUNNING_STATES.has(fresh.project.status);
            if (ended) setStatus(fresh.project.status);
          }
        } catch {
          /* offline, or the server is restarting: try again */
        }
        if (ended) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(15_000, 1500 * (attempt + 1))));
      }
    } finally {
      following.current = false;
      setRunning(false);
    }
  }, [consume, project.id]);

  // A run that is in progress when the page opens (started earlier, by a
  // schedule, or through the API) is followed from here on.
  useEffect(() => {
    if (RUNNING_STATES.has(project.status)) void follow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run() {
    if (following.current) return;
    setRunning(true);
    setError(null);
    try {
      const instruction = runInput.trim();
      const res = await fetch(`/api/projects/${project.id}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(instruction ? { input: instruction } : {}),
      });
      if (res.status === 409) {
        // Already running (started in another tab, by a schedule, through the API).
        setRunning(false);
        await follow();
        return;
      }
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.message ?? "Run failed to start");
      }
      // A new run replaces the tasks; what they generated stays in the library.
      setDeliverable(null);
      setReview(null);
      setEarlierMedia((n) => n + countAssets(tasks, "ready") + countAssets(tasks, "pending"));
      setTasks([]);
      setTraces({});
      setOpenTraces(new Set());
      setBudgetUsed(0);
      setStatus("queued");
      setRunInput("");
      setShowInput(false);
      following.current = true;
      try {
        await consume(res);
      } finally {
        following.current = false;
      }
      // If the connection was cut while the run goes on, pick it up again.
      const fresh = await apiFetch<{ project: ProjectDTO }>(`/api/projects/${project.id}`).catch(() => null);
      if (fresh && RUNNING_STATES.has(fresh.project.status)) {
        setRunning(false);
        await follow();
        return;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Run failed");
    } finally {
      setRunning(false);
    }
  }

  /** Show or hide what tools a task called. A finished task's calls are read from the server. */
  async function toggleTrace(t: TaskLive) {
    const open = !openTraces.has(t.seq);
    setOpenTraces((prev) => {
      const next = new Set(prev);
      if (open) next.add(t.seq);
      else next.delete(t.seq);
      return next;
    });
    if (!open || !t.id || t.status === "running" || traces[t.seq]) return;
    setTraces((prev) => ({ ...prev, [t.seq]: "loading" }));
    try {
      const res = await apiFetch<{ calls: TraceCall[] }>(`/api/projects/${project.id}/tasks/${t.id}/tool-calls`);
      setTraces((prev) => ({ ...prev, [t.seq]: res.calls }));
    } catch {
      setTraces((prev) => ({ ...prev, [t.seq]: undefined }));
    }
  }

  async function cancel() {
    try {
      await apiFetch(`/api/projects/${project.id}/cancel`, { method: "POST" });
    } catch {
      /* ignore */
    }
  }

  async function approveAndRun() {
    setApproving(true);
    setError(null);
    try {
      await apiFetch(`/api/projects/${project.id}/approve`, { method: "POST" });
      setApproving(false);
      await run();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Approval failed");
      setApproving(false);
    }
  }

  const isRunning = running || RUNNING_STATES.has(status);
  const hasMediaModels = Boolean(imageModelLabel || videoModelLabel || speechModelLabel);
  const readyMedia = countAssets(tasks, "ready");
  const pendingMedia = countAssets(tasks, "pending");

  return (
    <div>
      <PageHeader
        title={project.title}
        actions={
          <div className="flex items-center gap-2">
            <Link href={`/dashboard/projects/${project.id}/workspace`} className="btn-ghost">
              <Icon name="models" /> Workspace
            </Link>
            {isRunning ? (
              <Button variant="ghost" onClick={cancel}>
                <Icon name="stop" /> Cancel
              </Button>
            ) : (
              <>
                <Button variant="ghost" onClick={() => setShowInput((v) => !v)} disabled={!canRun} aria-expanded={showInput} title="Give this run an extra instruction">
                  <Icon name="plus" /> Instruction
                </Button>
                <Button onClick={run} loading={running} disabled={!canRun}>
                  <Icon name="test" /> {tasks.length > 0 ? "Re-run" : "Run"}
                </Button>
              </>
            )}
          </div>
        }
      />

      {showInput && !isRunning && (
        <div className="mb-4 rounded-md border border-line bg-surface-2/40 p-3">
          <label htmlFor="run-input" className="label">
            Instruction for this run
          </label>
          <Input
            id="run-input"
            value={runInput}
            onChange={(e) => setRunInput(e.target.value)}
            maxLength={4000}
            placeholder="Optional, for this run only. e.g. Focus on the mobile layout this time."
            className="mt-1.5"
            onKeyDown={(e) => {
              if (e.key === "Enter") void run();
            }}
          />
          <p className="mt-1.5 text-xs text-ink-3">It is added to the goal for this run. The goal itself stays as it is.</p>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <StateBadge state={status} />
        {isRunning && (
          <span className="text-xs text-ink-3">
            {status === "queued" ? "waiting to start…" : "working… you can leave this page; the run goes on"}
          </span>
        )}
        {project.requiresApproval && <span className="text-xs text-ink-3">· approval required</span>}
        <span className="text-xs text-ink-3">
          · budget {formatNumber(budgetUsed)} / {formatNumber(budgetLimit)} tokens · max {project.maxParallel}× parallel
        </span>
        {hasMediaModels && (
          <span className="text-xs text-ink-3">
            · {[
              imageModelLabel ? `images: ${imageModelLabel}` : "",
              videoModelLabel ? `videos: ${videoModelLabel}` : "",
              speechModelLabel ? `voice: ${speechModelLabel}` : "",
            ]
              .filter(Boolean)
              .join(" · ")}{" "}
            · up to {project.maxMedia} per run
          </span>
        )}
      </div>

      {budgetLimit > 0 && (
        <div className="mb-4 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
          <div
            className={`h-full ${budgetUsed > budgetLimit ? "bg-danger" : "bg-signal"}`}
            style={{ width: `${Math.min(100, Math.round((budgetUsed / budgetLimit) * 100))}%` }}
          />
        </div>
      )}

      {status === "needs_approval" && (
        <div className="mb-4">
          <Alert tone="warn">
            This project requires approval before it runs.{" "}
            {canApprove ? "As an admin you can approve and run it now." : "Waiting for an admin to approve."}
          </Alert>
          {canApprove && (
            <div className="mt-2">
              <Button onClick={approveAndRun} loading={approving}>
                <Icon name="check" /> Approve &amp; run
              </Button>
            </div>
          )}
        </div>
      )}

      {!canRun && <Alert tone="warn">No usable agents/models yet — add a model and at least one agent with a model.</Alert>}
      {error && <div className="my-3"><Alert tone="danger">{error}</Alert></div>}

      <Card title="Goal" className="mb-6">
        <p className="whitespace-pre-wrap text-sm text-ink-2">{project.goal}</p>
      </Card>

      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-3">
        Tasks {tasks.length > 0 && `(${tasks.length})`}
      </h2>
      {tasks.length === 0 ? (
        <Card><p className="text-sm text-ink-3">No tasks yet. Run the project to let the Manager plan it.</p></Card>
      ) : (
        <ol className="space-y-3">
          {tasks.map((t) => (
            <li key={t.seq}>
              <Card>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="mono text-xs text-ink-3">#{t.seq}</span>
                      <span className="font-medium text-ink">{t.title}</span>
                      {t.kind !== "text" && (
                        <Badge tone="signal">
                          <Icon name={t.kind} size={12} /> {KIND_LABEL[t.kind]}
                        </Badge>
                      )}
                      {t.agent && t.kind !== "render" && <Badge tone="info">{t.agent}</Badge>}
                      {(t.toolCalls ?? t.calls?.length ?? 0) > 0 && (
                        <button
                          type="button"
                          onClick={() => void toggleTrace(t)}
                          className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-2 hover:text-ink"
                          aria-expanded={openTraces.has(t.seq)}
                        >
                          <Icon name="tool" size={12} />
                          {t.toolCalls ?? t.calls?.length} tool {(t.toolCalls ?? t.calls?.length) === 1 ? "call" : "calls"}
                          {t.steps ? ` · ${t.steps} steps` : ""}
                        </button>
                      )}
                    </div>
                    {t.status === "running" && t.progress && <p className="mt-2 text-xs text-ink-3">{t.progress}…</p>}
                    {t.error && <p className="mt-2 whitespace-pre-wrap rounded border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-xs text-danger">{t.error}</p>}
                  </div>
                  <StateBadge state={t.status} />
                </div>
                {/* What the agent is doing, while it works: its latest tool calls. */}
                {t.status === "running" && (t.calls?.length ?? 0) > 0 && !openTraces.has(t.seq) && (
                  <ul className="mt-2 space-y-0.5">
                    {t.calls!.slice(-3).map((c, i) => (
                      <li key={`${c.step}-${i}`} className={cn("mono truncate text-[11px]", c.isError ? "text-warn" : "text-ink-3")}>
                        {c.name} {c.summary}
                      </li>
                    ))}
                  </ul>
                )}
                {openTraces.has(t.seq) && (
                  <div className="mt-3 rounded-md border border-line bg-surface-2/50 p-3">
                    {t.status === "running" || !t.id ? (
                      <ul className="space-y-1">
                        {(t.calls ?? []).map((c, i) => (
                          <li key={`${c.step}-${i}`} className="mono text-[11px] text-ink-2">
                            <span className="text-ink-3">step {c.step}</span> {c.name} {c.summary}
                            {c.isError && <span className="text-warn"> · refused or failed</span>}
                          </li>
                        ))}
                      </ul>
                    ) : traces[t.seq] === "loading" ? (
                      <p className="text-xs text-ink-3">Loading…</p>
                    ) : !traces[t.seq] ? (
                      <p className="text-xs text-ink-3">The tool calls could not be loaded.</p>
                    ) : (
                      <ol className="space-y-2">
                        {(traces[t.seq] as TraceCall[]).map((c) => (
                          <li key={c.id} className="text-xs">
                            <p className="mono text-ink">
                              <span className="text-ink-3">step {c.step}</span> {c.name}
                              {c.isError && <span className="text-warn"> · refused or failed</span>}
                              {c.durationMs != null && <span className="text-ink-3"> · {c.durationMs} ms</span>}
                            </p>
                            {c.arguments && c.arguments !== "{}" && (
                              <pre className="mono mt-0.5 max-h-24 overflow-auto whitespace-pre-wrap break-all text-[11px] text-ink-3">{c.arguments}</pre>
                            )}
                            {c.result && (
                              <pre className={cn("mono mt-0.5 max-h-32 overflow-auto whitespace-pre-wrap break-words text-[11px]", c.isError ? "text-warn" : "text-ink-2")}>
                                {c.result}
                              </pre>
                            )}
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                )}
                {shownAssets(t).length > 0 && (
                  <div className="mt-3 space-y-3">
                    {shownAssets(t).map((asset) =>
                      asset.status === "failed" ? (
                        <p key={asset.id} className="text-xs text-danger">
                          The {asset.source === "render" ? "joined video" : asset.kind === "audio" ? "voice-over" : asset.kind} was not made: {asset.error}
                        </p>
                      ) : (
                        <div key={asset.id} className="max-w-xl">
                          <MediaView asset={asset} heightClass="h-80" />
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-3">
                            <span>{asset.modelLabel}</span>
                            {asset.status === "pending" && (
                              <span>· {asset.source === "render" ? "being joined on this server" : "still in progress at the provider"}</span>
                            )}
                            {asset.status === "ready" && asset.error && <span className="text-warn">· {asset.error}</span>}
                            {asset.url && (
                              <a href={`${asset.url}?download=1`} className="btn-ghost px-2 py-1 text-xs" download>
                                <Icon name="download" size={14} /> Download
                              </a>
                            )}
                          </div>
                        </div>
                      ),
                    )}
                  </div>
                )}
                {t.artifact && (
                  <div className="mt-3">
                    <button
                      onClick={() =>
                        setExpanded((prev) => {
                          const n = new Set(prev);
                          if (n.has(t.seq)) n.delete(t.seq);
                          else n.add(t.seq);
                          return n;
                        })
                      }
                      className="text-xs font-medium text-signal hover:underline"
                    >
                      {expanded.has(t.seq) ? "Hide" : "View"}{" "}
                      {t.kind === "text" ? "output" : t.kind === "audio" ? "spoken text" : t.kind === "render" ? "details" : "prompt"}
                    </button>
                    {expanded.has(t.seq) && (
                      <pre className={cn("mt-2 max-h-80 overflow-auto rounded-md border border-line bg-surface-2 p-3 text-xs text-ink-2", "whitespace-pre-wrap")}>
                        {t.artifact}
                      </pre>
                    )}
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ol>
      )}

      {readyMedia + pendingMedia + earlierMedia > 0 && (
        <p className="mt-4 text-xs text-ink-3">
          {readyMedia > 0 && `This run generated ${readyMedia} ${readyMedia === 1 ? "file" : "files"}. `}
          {pendingMedia > 0 &&
            `${pendingMedia} ${pendingMedia === 1 ? "video is" : "videos are"} still in progress. `}
          {earlierMedia > 0 &&
            `${earlierMedia} ${earlierMedia === 1 ? "file" : "files"} from earlier runs ${earlierMedia === 1 ? "is" : "are"} kept too. `}
          <Link href={`/dashboard/studio?project=${project.id}`} className="font-medium text-signal hover:underline">
            Open this project&apos;s media in Creative Studio
          </Link>
        </p>
      )}

      {deliverable && (
        <div className="mt-6">
          <Card title="Final deliverable" description="Consolidated by the AI Manager (LLM synthesis, not automated verification).">
            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-ink">{deliverable}</pre>
          </Card>
        </div>
      )}

      {review && (
        <div className="mt-6">
          <Card title="QA / Security review" description="Advisory reviewer assessment — grounded in sandbox test output when available, not a substitute for automated verification.">
            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-ink-2">{review}</pre>
          </Card>
        </div>
      )}

      <ProjectAutomation
        projectId={project.id}
        initialSchedules={initialSchedules}
        initialRuns={initialRuns}
        initialMemory={project.memory}
        refreshKey={finishedRuns}
      />
    </div>
  );
}
