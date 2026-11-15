"use client";

import { useEffect, useState } from "react";
import { describeCron, nextRuns, scheduleProblem } from "@/lib/cron";
import { apiFetch, ApiError } from "@/lib/client";
import { formatDateTime, formatNumber } from "@/lib/format";
import { DateTime, RelativeTime, TimeText } from "@/components/time";
import type { RunDTO } from "@/lib/runs";
import type { ScheduleDTO } from "@/lib/schedules";
import { Alert, Badge, Button, Card, Field, Input, Select, Toggle } from "@/components/ui";
import { Icon } from "@/components/icons";
import { StateBadge } from "./status-badge";

const PRESETS: { label: string; cron: string }[] = [
  { label: "Every day at 08:00", cron: "0 8 * * *" },
  { label: "Every weekday at 08:00", cron: "0 8 * * 1-5" },
  { label: "Every Monday at 09:00", cron: "0 9 * * 1" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every 6 hours", cron: "0 */6 * * *" },
  { label: "On the 1st of the month at 09:00", cron: "0 9 1 * *" },
];

const COMMON_ZONES = ["UTC", "Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura", "Asia/Singapore", "Europe/London", "America/New_York"];

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function inZone(time: number, timeZone: string): string {
  try {
    return new Date(time).toLocaleString("en-GB", {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return formatDateTime(time);
  }
}

const TRIGGER: Record<RunDTO["trigger"], string> = { manual: "started by hand", schedule: "schedule", api: "API" };

function duration(run: RunDTO): string | null {
  if (!run.startedAt || !run.finishedAt) return null;
  const seconds = Math.max(0, Math.round((run.finishedAt - run.startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * What a project does without anyone watching: the schedules that start its
 * runs, whether a run is told about the ones before it, and the runs so far.
 */
export function ProjectAutomation({
  projectId,
  initialSchedules,
  initialRuns,
  initialMemory,
  refreshKey,
}: {
  projectId: string;
  initialSchedules: ScheduleDTO[];
  initialRuns: RunDTO[];
  initialMemory: boolean;
  /** Changes when a run ends, so that the history is read again. */
  refreshKey: number;
}) {
  const [schedules, setSchedules] = useState(initialSchedules);
  const [runs, setRuns] = useState(initialRuns);
  const [memory, setMemory] = useState(initialMemory);
  const [adding, setAdding] = useState(false);
  const [cron, setCron] = useState(PRESETS[0]!.cron);
  const [preset, setPreset] = useState(PRESETS[0]!.cron);
  const [timezone, setTimezone] = useState("UTC");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [shown, setShown] = useState<{ id: string; text: string | null; review: string | null } | null>(null);

  // The browser's zone is only known in the browser.
  useEffect(() => setTimezone(browserZone()), []);

  useEffect(() => {
    if (refreshKey === 0) return;
    let stopped = false;
    void (async () => {
      try {
        const [r, s] = await Promise.all([
          apiFetch<{ runs: RunDTO[] }>(`/api/projects/${projectId}/runs`),
          apiFetch<{ schedules: ScheduleDTO[] }>(`/api/projects/${projectId}/schedules`),
        ]);
        if (stopped) return;
        setRuns(r.runs);
        setSchedules(s.schedules);
      } catch {
        /* the next run refreshes it */
      }
    })();
    return () => {
      stopped = true;
    };
  }, [refreshKey, projectId]);

  const problem = scheduleProblem(cron.trim(), timezone);
  let preview: number[] = [];
  let words = "";
  if (!problem) {
    try {
      preview = nextRuns(cron.trim(), new Date(), timezone, 3).map((d) => d.getTime());
      words = describeCron(cron.trim());
    } catch {
      /* shown as a problem by the server if it comes to that */
    }
  }
  const zones = [...new Set([timezone, browserZone(), ...COMMON_ZONES])];

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy("add");
    try {
      const res = await apiFetch<{ schedule: ScheduleDTO }>(`/api/projects/${projectId}/schedules`, {
        method: "POST",
        body: JSON.stringify({ cron: cron.trim(), timezone, input: input.trim() || null }),
      });
      setSchedules((list) => [...list, res.schedule]);
      setAdding(false);
      setInput("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the schedule");
    } finally {
      setBusy(null);
    }
  }

  async function toggle(s: ScheduleDTO) {
    setBusy(s.id);
    setError(null);
    try {
      const res = await apiFetch<{ schedule: ScheduleDTO }>(`/api/projects/${projectId}/schedules/${s.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !s.enabled }),
      });
      setSchedules((list) => list.map((x) => (x.id === s.id ? res.schedule : x)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not change the schedule");
    } finally {
      setBusy(null);
    }
  }

  async function remove(s: ScheduleDTO) {
    if (!confirm(`Delete the schedule "${s.description}"?`)) return;
    setBusy(s.id);
    try {
      await apiFetch(`/api/projects/${projectId}/schedules/${s.id}`, { method: "DELETE" });
      setSchedules((list) => list.filter((x) => x.id !== s.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete the schedule");
    } finally {
      setBusy(null);
    }
  }

  async function setRemember(value: boolean) {
    setMemory(value);
    try {
      await apiFetch(`/api/projects/${projectId}`, { method: "PATCH", body: JSON.stringify({ memory: value }) });
    } catch (err) {
      setMemory(!value);
      setError(err instanceof ApiError ? err.message : "Could not change the setting");
    }
  }

  async function show(run: RunDTO) {
    if (shown?.id === run.id) return setShown(null);
    try {
      const res = await apiFetch<{ run: RunDTO & { deliverable: string | null; reviewNotes: string | null } }>(
        `/api/projects/${projectId}/runs/${run.id}`,
      );
      setShown({ id: run.id, text: res.run.deliverable, review: res.run.reviewNotes });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the run");
    }
  }

  return (
    <div className="mt-6 space-y-6">
      {error && <Alert tone="danger">{error}</Alert>}

      <Card
        title="Schedules"
        description="Run this project by itself. The server starts the run at the time; no page has to be open."
        actions={
          !adding ? (
            <Button variant="ghost" onClick={() => setAdding(true)}>
              <Icon name="plus" /> Add schedule
            </Button>
          ) : undefined
        }
      >
        {adding && (
          <form onSubmit={add} className="mb-4 space-y-4 rounded-md border border-line bg-surface-2/40 p-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="When" htmlFor="s-preset">
                <Select
                  id="s-preset"
                  value={preset}
                  onChange={(e) => {
                    setPreset(e.target.value);
                    if (e.target.value !== "custom") setCron(e.target.value);
                  }}
                >
                  {PRESETS.map((p) => (
                    <option key={p.cron} value={p.cron}>
                      {p.label}
                    </option>
                  ))}
                  <option value="custom">Something else…</option>
                </Select>
              </Field>
              <Field label="Cron expression" htmlFor="s-cron" hint="minute hour day-of-month month day-of-week" error={cron.trim() ? problem : null}>
                <Input
                  id="s-cron"
                  value={cron}
                  onChange={(e) => {
                    setCron(e.target.value);
                    setPreset(PRESETS.some((p) => p.cron === e.target.value.trim()) ? e.target.value.trim() : "custom");
                  }}
                  className="mono"
                  required
                  spellCheck={false}
                />
              </Field>
              <Field label="Time zone" htmlFor="s-zone" hint="An IANA name, such as Asia/Jakarta.">
                <Input id="s-zone" value={timezone} onChange={(e) => setTimezone(e.target.value)} list="s-zones" required />
                <datalist id="s-zones">
                  {zones.map((z) => (
                    <option key={z} value={z} />
                  ))}
                </datalist>
              </Field>
            </div>
            <Field label="Instruction for these runs" htmlFor="s-input" hint="Optional. Added to the project's goal for every run this schedule starts.">
              <Input id="s-input" value={input} onChange={(e) => setInput(e.target.value)} maxLength={4000} placeholder="e.g. Cover what happened since yesterday." />
            </Field>
            {!problem && preview.length > 0 && (
              <p className="text-xs text-ink-3">
                {words}. Next: {preview.map((t) => inZone(t, timezone)).join(" · ")} ({timezone}).
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={busy === "add"} disabled={Boolean(problem)}>
                Save schedule
              </Button>
            </div>
          </form>
        )}

        {schedules.length === 0 ? (
          !adding && <p className="text-sm text-ink-3">No schedule. The project runs when someone starts it.</p>
        ) : (
          <ul className="divide-y divide-line">
            {schedules.map((s) => (
              <li key={s.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Icon name="clock" size={15} className="text-ink-3" />
                    <span className="text-sm font-medium text-ink">{s.description}</span>
                    <span className="mono text-xs text-ink-3">{s.cron}</span>
                    <span className="text-xs text-ink-3">{s.timezone}</span>
                    {!s.enabled && <Badge>off</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-ink-3">
                    {s.enabled && s.nextRunAt ? <>Next: <TimeText at={s.nextRunAt} text={(date) => inZone(date.getTime(), s.timezone)} /></> : "Not scheduled"}
                    {s.lastStatus && (
                      <span className={s.lastStatus === "error" ? "text-danger" : s.lastStatus === "skipped" ? "text-warn" : ""}>
                        {" · "}last time: {s.lastStatus}
                        {s.lastError ? ` (${s.lastError})` : ""}
                        {s.lastRunAt ? <>, <RelativeTime at={s.lastRunAt} /></> : ""}
                      </span>
                    )}
                  </p>
                  {s.input && <p className="mt-1 text-xs text-ink-2">Instruction: {s.input}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <Toggle checked={s.enabled} onChange={() => toggle(s)} disabled={busy === s.id} label={`Schedule ${s.description}`} />
                  <Button variant="danger" onClick={() => remove(s)} disabled={busy === s.id} aria-label="Delete schedule">
                    <Icon name="trash" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex items-start justify-between gap-4 border-t border-line pt-4">
          <div>
            <p className="text-sm text-ink">Remember earlier runs</p>
            <p className="text-xs text-ink-3">
              Each run is told what the last three runs delivered, so it builds on them instead of repeating them.
            </p>
          </div>
          <Toggle checked={memory} onChange={setRemember} label="Remember earlier runs" />
        </div>
      </Card>

      <Card title="Runs" description="Every run of this project, newest first. A run keeps what it delivered; its tasks are replaced by the next run's.">
        {runs.length === 0 ? (
          <p className="text-sm text-ink-3">No run yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {runs.map((run) => (
              <li key={run.id} className="py-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StateBadge state={run.status} />
                      <DateTime at={run.createdAt} className="text-sm text-ink-2" />
                      <span className="text-xs text-ink-3">
                        {TRIGGER[run.trigger]}
                        {duration(run) ? ` · ${duration(run)}` : ""}
                        {run.tokensUsed > 0 ? ` · ${formatNumber(run.tokensUsed)} tokens` : ""}
                      </span>
                    </div>
                    {run.input && <p className="mt-1 text-xs text-ink-2">Instruction: {run.input}</p>}
                    {run.error && <p className="mt-1 text-xs text-danger">{run.error}</p>}
                  </div>
                  {run.hasDeliverable && (
                    <button type="button" className="text-xs font-medium text-signal hover:underline" onClick={() => show(run)}>
                      {shown?.id === run.id ? "Hide" : "View"} what it delivered
                    </button>
                  )}
                </div>
                {shown?.id === run.id && (
                  <div className="mt-3 space-y-3">
                    <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-surface-2 p-3 font-sans text-sm text-ink">
                      {shown.text ?? "(nothing)"}
                    </pre>
                    {shown.review && (
                      <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-surface-2 p-3 font-sans text-xs text-ink-2">
                        {shown.review}
                      </pre>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
