"use client";

import Link from "next/link";
import { useState } from "react";
import type { ProjectDTO } from "@/lib/workforce";
import { apiFetch, ApiError } from "@/lib/client";
import { Alert, Badge, Button, Card, PageHeader, cn } from "@/components/ui";
import { Icon } from "@/components/icons";
import { StateBadge } from "./status-badge";

interface TaskLive {
  seq: number;
  title: string;
  agent: string | null;
  status: string;
  artifact?: string | null;
  error?: string | null;
}

const RUNNING_STATES = new Set(["planning", "running"]);

export function ProjectRunner({
  project,
  agentNames,
  canRun,
  canApprove,
}: {
  project: ProjectDTO;
  agentNames: Record<string, string>;
  canRun: boolean;
  canApprove: boolean;
}) {
  const [status, setStatus] = useState(project.status);
  const [tasks, setTasks] = useState<TaskLive[]>(
    project.tasks.map((t) => ({
      seq: t.seq,
      title: t.title,
      agent: t.agentId ? agentNames[t.agentId] ?? null : null,
      status: t.status,
      artifact: t.artifact,
      error: t.error,
    })),
  );
  const [deliverable, setDeliverable] = useState<string | null>(project.finalDeliverable);
  const [review, setReview] = useState<string | null>(project.reviewNotes);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [budgetUsed, setBudgetUsed] = useState(project.tokensUsed);
  const [budgetLimit, setBudgetLimit] = useState(project.maxTokens);
  const [approving, setApproving] = useState(false);

  function upsert(t: Partial<TaskLive> & { seq: number }) {
    setTasks((prev) => {
      const i = prev.findIndex((x) => x.seq === t.seq);
      if (i === -1) return [...prev, { title: "", agent: null, status: "queued", ...t } as TaskLive].sort((a, b) => a.seq - b.seq);
      const n = [...prev];
      n[i] = { ...n[i]!, ...t };
      return n;
    });
  }

  async function run() {
    setRunning(true);
    setError(null);
    setDeliverable(null);
    setReview(null);
    setTasks([]);
    setBudgetUsed(0);
    setStatus("planning");
    try {
      const res = await fetch(`/api/projects/${project.id}/run`, { method: "POST" });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.message ?? "Run failed to start");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const s = line.trim();
          if (!s.startsWith("data:")) continue;
          const payload = s.slice(5).trim();
          if (!payload) continue;
          try {
            const evt = JSON.parse(payload);
            switch (evt.type) {
              case "status":
                setStatus(evt.status);
                break;
              case "plan":
                setTasks(
                  evt.tasks.map((t: { seq: number; title: string; agent: string }) => ({
                    seq: t.seq,
                    title: t.title,
                    agent: t.agent,
                    status: "queued",
                  })),
                );
                break;
              case "task":
                upsert({ seq: evt.seq, title: evt.title, agent: evt.agent, status: evt.status, artifact: evt.artifact, error: evt.error });
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
                break;
            }
          } catch {
            /* ignore */
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Run failed");
    } finally {
      setRunning(false);
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
              <Button onClick={run} loading={running} disabled={!canRun}>
                <Icon name="test" /> {tasks.length > 0 ? "Re-run" : "Run"}
              </Button>
            )}
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <StateBadge state={status} />
        {isRunning && <span className="text-xs text-ink-3">working…</span>}
        {project.requiresApproval && <span className="text-xs text-ink-3">· approval required</span>}
        <span className="text-xs text-ink-3">
          · budget {budgetUsed.toLocaleString()} / {budgetLimit.toLocaleString()} tokens · max {project.maxParallel}× parallel
        </span>
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
                      {t.agent && <Badge tone="info">{t.agent}</Badge>}
                    </div>
                    {t.error && <p className="mt-2 rounded border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-xs text-danger">{t.error}</p>}
                  </div>
                  <StateBadge state={t.status} />
                </div>
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
                      {expanded.has(t.seq) ? "Hide output" : "View output"}
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
    </div>
  );
}
