"use client";

import { useState } from "react";
import type { WorkflowDTO } from "@/lib/workforce";
import { ASPECT_RATIOS, MAX_VIDEO_SECONDS } from "@/lib/adapters/media-protocol";
import type { TaskKind } from "@/lib/creative/prompt";
import {
  REEL_DEFAULT_CLIP_SECONDS,
  REEL_DEFAULT_SCENES,
  REEL_MAX_CLIP_SECONDS,
  REEL_MAX_SCENES,
  reelWorkflowTemplate,
} from "@/lib/creative/templates";
import { apiFetch, ApiError } from "@/lib/client";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { Icon } from "@/components/icons";

interface StepForm {
  title: string;
  objective: string;
  acceptanceCriteria: string;
  role: string;
  outputFile: string;
  dependsOn: string; // csv of step numbers
  kind: TaskKind;
  aspectRatio: string;
  durationSeconds: string;
  resolution: string;
  /** Kept as saved; the builder has no field for it. */
  size: string;
}

const emptyStep: StepForm = {
  title: "",
  objective: "",
  acceptanceCriteria: "",
  role: "",
  outputFile: "",
  dependsOn: "",
  kind: "text",
  aspectRatio: "",
  durationSeconds: "",
  resolution: "",
  size: "",
};

type SavedStep = WorkflowDTO["steps"][number];

function toForm(s: Pick<SavedStep, "title" | "objective" | "role"> & Partial<SavedStep>): StepForm {
  return {
    title: s.title,
    objective: s.objective,
    acceptanceCriteria: s.acceptanceCriteria ?? "",
    role: s.role,
    outputFile: s.outputFile ?? "",
    dependsOn: (s.dependsOn ?? []).join(","),
    kind: s.kind ?? "text",
    aspectRatio: s.media?.aspectRatio ?? "",
    durationSeconds: s.media?.durationSeconds ? String(s.media.durationSeconds) : "",
    resolution: s.media?.resolution ?? "",
    size: s.media?.size ?? "",
  };
}

function parseDeps(csv: string): number[] {
  return csv
    .split(",")
    .map((x) => parseInt(x.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** Rewrite every step's "depends on" numbers after steps moved or went away. */
function renumber(steps: StepForm[], newNumber: (old: number) => number | null): StepForm[] {
  return steps.map((s) => ({
    ...s,
    dependsOn: parseDeps(s.dependsOn)
      .map(newNumber)
      .filter((n): n is number => n !== null)
      .join(","),
  }));
}

function mediaCounts(steps: { kind?: TaskKind }[]): string {
  const videos = steps.filter((s) => s.kind === "video").length;
  const images = steps.filter((s) => s.kind === "image").length;
  return [
    videos > 0 ? `${videos} ${videos === 1 ? "video" : "videos"}` : "",
    images > 0 ? `${images} ${images === 1 ? "image" : "images"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function Builder({
  initial,
  onSaved,
  onCancel,
}: {
  initial?: WorkflowDTO;
  onSaved: (w: WorkflowDTO) => void;
  onCancel: () => void;
}) {
  const editing = Boolean(initial);
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [steps, setSteps] = useState<StepForm[]>(
    initial?.steps.length ? initial.steps.map(toForm) : [{ ...emptyStep }],
  );
  const [reelScenes, setReelScenes] = useState(String(REEL_DEFAULT_SCENES));
  const [reelSeconds, setReelSeconds] = useState(String(REEL_DEFAULT_CLIP_SECONDS));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function update(i: number, patch: Partial<StepForm>) {
    setSteps((s) => s.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  }
  function move(i: number, dir: -1 | 1) {
    setSteps((s) => {
      const j = i + dir;
      if (j < 0 || j >= s.length) return s;
      const n = [...s];
      [n[i], n[j]] = [n[j]!, n[i]!];
      // The two steps swapped numbers: what depends on them follows.
      return renumber(n, (old) => (old === i + 1 ? j + 1 : old === j + 1 ? i + 1 : old));
    });
  }
  function removeStep(i: number) {
    setSteps((s) =>
      renumber(
        s.filter((_, idx) => idx !== i),
        (old) => (old === i + 1 ? null : old > i + 1 ? old - 1 : old),
      ),
    );
  }

  function applyReelTemplate() {
    const hasContent = steps.some((s) => s.title.trim() || s.objective.trim());
    if (hasContent && !confirm("Replace the steps below with the Reel template?")) return;
    const template = reelWorkflowTemplate({
      scenes: Number(reelScenes) || undefined,
      clipSeconds: Number(reelSeconds) || undefined,
    });
    setName((current) => current.trim() || template.name);
    setDescription((current) => current.trim() || template.description);
    setSteps(template.steps.map(toForm));
    setError(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const kept = steps
      .map((s, i) => ({ s, number: i + 1 }))
      .filter(({ s }) => s.title.trim() && s.objective.trim() && s.role.trim());
    if (kept.length < steps.length) {
      // Dropping a step silently would shift the numbers other steps depend on.
      const unfinished = steps.length - kept.length;
      setError(
        `${unfinished === 1 ? "One step is" : `${unfinished} steps are`} missing a title, an agent role or an objective. Fill ${unfinished === 1 ? "it" : "them"} in or remove ${unfinished === 1 ? "it" : "them"}.`,
      );
      return;
    }
    for (const { s, number } of kept) {
      const later = parseDeps(s.dependsOn).find((d) => d >= number);
      if (later !== undefined) {
        setError(`Step ${number} depends on step ${later}. A step can only depend on steps before it.`);
        return;
      }
    }

    const payloadSteps = kept.map(({ s }) => {
      const media =
        s.kind === "text"
          ? undefined
          : {
              aspectRatio: s.aspectRatio.trim() || undefined,
              durationSeconds: s.kind === "video" && s.durationSeconds.trim() ? Number(s.durationSeconds) : undefined,
              resolution: s.resolution.trim() || undefined,
              size: s.size.trim() || undefined,
            };
      return {
        title: s.title.trim(),
        objective: s.objective.trim(),
        acceptanceCriteria: s.acceptanceCriteria.trim() || undefined,
        role: s.role.trim(),
        // An image / video step delivers the generated file, not a workspace file.
        outputFile: s.kind === "text" ? s.outputFile.trim() || undefined : undefined,
        dependsOn: parseDeps(s.dependsOn),
        kind: s.kind,
        media,
      };
    });

    setLoading(true);
    try {
      const body = JSON.stringify({ name, description: description || undefined, steps: payloadSteps });
      const res = editing
        ? await apiFetch<{ workflow: WorkflowDTO }>(`/api/workflows/${initial!.id}`, { method: "PATCH", body })
        : await apiFetch<{ workflow: WorkflowDTO }>("/api/workflows", { method: "POST", body });
      onSaved(res.workflow);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save workflow");
      setLoading(false);
    }
  }

  const counts = mediaCounts(steps);

  return (
    <form onSubmit={save} className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}

      {!editing && (
        <div className="rounded-md border border-line bg-surface-2/40 p-3">
          <p className="text-sm font-medium text-ink">Start from the Reel template</p>
          <p className="mt-0.5 text-xs text-ink-3">
            A short vertical video: script, storyboard, one generated clip per scene, a cover image and a caption.
            The clips are separate files; joining them into one video is done in a video editor.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <Field label="Scenes" htmlFor="w-reel-scenes">
              <Select id="w-reel-scenes" value={reelScenes} onChange={(e) => setReelScenes(e.target.value)} className="w-24">
                {Array.from({ length: REEL_MAX_SCENES }, (_, i) => String(i + 1)).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Seconds per clip" htmlFor="w-reel-seconds">
              <Input
                id="w-reel-seconds"
                type="number"
                min={1}
                max={REEL_MAX_CLIP_SECONDS}
                step={1}
                value={reelSeconds}
                onChange={(e) => setReelSeconds(e.target.value)}
                className="w-32"
              />
            </Field>
            <Button type="button" variant="ghost" onClick={applyReelTemplate}>
              <Icon name="video" size={16} /> Use template
            </Button>
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="w-name">
          <Input id="w-name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Spec → Build → Review" />
        </Field>
        <Field label="Description" htmlFor="w-desc">
          <Input id="w-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="optional" />
        </Field>
      </div>

      <p className="text-xs text-ink-3">
        A step goes to the agent whose name or role matches its agent role, or to the first agent of the team when none
        does. A step that delivers an image or a video has its agent write the prompt; the project&apos;s image or video
        model then generates one file from it.
        {counts && ` This workflow generates ${counts} per run.`}
      </p>

      <div className="space-y-3">
        {steps.map((s, i) => (
          <div key={i} className="rounded-md border border-line bg-surface-2/40 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold text-ink-3">Step {i + 1}</span>
              <div className="flex gap-1">
                <button type="button" onClick={() => move(i, -1)} className="btn-ghost px-2 py-1 text-xs" aria-label="Move up">↑</button>
                <button type="button" onClick={() => move(i, 1)} className="btn-ghost px-2 py-1 text-xs" aria-label="Move down">↓</button>
                <button type="button" onClick={() => removeStep(i)} className="btn-ghost px-2 py-1 text-xs text-danger" aria-label="Remove">✕</button>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Input value={s.title} onChange={(e) => update(i, { title: e.target.value })} placeholder="Title" aria-label={`Step ${i + 1} title`} />
              <Input value={s.role} onChange={(e) => update(i, { role: e.target.value })} placeholder="Agent role (e.g. Engineer)" aria-label={`Step ${i + 1} agent role`} />
            </div>
            <Textarea
              value={s.objective}
              onChange={(e) => update(i, { objective: e.target.value })}
              placeholder={s.kind === "text" ? "Objective" : `What the ${s.kind} should show. The agent turns this into the prompt.`}
              aria-label={`Step ${i + 1} objective`}
              className="mt-2 min-h-[56px]"
            />
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <Select value={s.kind} onChange={(e) => update(i, { kind: e.target.value as TaskKind })} aria-label={`Step ${i + 1} delivers`}>
                <option value="text">Delivers text</option>
                <option value="image">Delivers an image</option>
                <option value="video">Delivers a video</option>
              </Select>
              <Input value={s.dependsOn} onChange={(e) => update(i, { dependsOn: e.target.value })} placeholder="Depends on steps (e.g. 1,2)" aria-label={`Step ${i + 1} depends on steps`} />
            </div>
            {s.kind === "text" ? (
              <Input
                value={s.outputFile}
                onChange={(e) => update(i, { outputFile: e.target.value })}
                placeholder="Output file (optional, e.g. src/x.ts)"
                aria-label={`Step ${i + 1} output file`}
                className="mono mt-2"
              />
            ) : (
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                <Select value={s.aspectRatio} onChange={(e) => update(i, { aspectRatio: e.target.value })} aria-label={`Step ${i + 1} aspect ratio`}>
                  <option value="">Aspect ratio: provider default</option>
                  {/* A ratio saved earlier that is not in the list stays selectable. */}
                  {s.aspectRatio && !(ASPECT_RATIOS as readonly string[]).includes(s.aspectRatio) && (
                    <option value={s.aspectRatio}>{s.aspectRatio}</option>
                  )}
                  {ASPECT_RATIOS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
                {s.kind === "video" && (
                  <Input
                    type="number"
                    min={1}
                    max={MAX_VIDEO_SECONDS}
                    step={1}
                    value={s.durationSeconds}
                    onChange={(e) => update(i, { durationSeconds: e.target.value })}
                    placeholder="Seconds (provider default)"
                    aria-label={`Step ${i + 1} length in seconds`}
                  />
                )}
                <Input
                  value={s.resolution}
                  onChange={(e) => update(i, { resolution: e.target.value })}
                  placeholder={s.kind === "video" ? "Resolution (e.g. 720p)" : "Resolution (e.g. 2K)"}
                  aria-label={`Step ${i + 1} resolution`}
                  maxLength={8}
                />
              </div>
            )}
            <Input
              value={s.acceptanceCriteria}
              onChange={(e) => update(i, { acceptanceCriteria: e.target.value })}
              placeholder="Acceptance criteria (optional)"
              aria-label={`Step ${i + 1} acceptance criteria`}
              className="mt-2"
            />
          </div>
        ))}
        <Button type="button" variant="ghost" onClick={() => setSteps((s) => [...s, { ...emptyStep }])}>
          <Icon name="plus" /> Add step
        </Button>
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" loading={loading}>{editing ? "Save workflow" : "Create workflow"}</Button>
      </div>
    </form>
  );
}

const STEPS_SHOWN = 6;

export function WorkflowsManager({ initialWorkflows, isAdmin }: { initialWorkflows: WorkflowDTO[]; isAdmin: boolean }) {
  const [list, setList] = useState(initialWorkflows);
  const [form, setForm] = useState<{ mode: "new" | "edit"; workflow?: WorkflowDTO } | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  function patch(w: WorkflowDTO) {
    setList((l) => {
      const i = l.findIndex((x) => x.id === w.id);
      if (i === -1) return [...l, w];
      const n = [...l];
      n[i] = w;
      return n;
    });
  }
  async function remove(w: WorkflowDTO) {
    if (!confirm(`Delete workflow "${w.name}"?`)) return;
    setBusy((b) => ({ ...b, [w.id]: true }));
    try {
      await apiFetch(`/api/workflows/${w.id}`, { method: "DELETE" });
      setList((l) => l.filter((x) => x.id !== w.id));
    } catch {
      setBusy((b) => ({ ...b, [w.id]: false }));
    }
  }

  return (
    <div>
      <PageHeader
        title="Workflows"
        description="Reusable, deterministic task plans. A project can run a workflow instead of AI-Manager planning."
        actions={isAdmin && !form ? <Button onClick={() => setForm({ mode: "new" })}><Icon name="plus" /> New workflow</Button> : undefined}
      />
      {form && (
        <div className="mb-6">
          <Card title={form.mode === "new" ? "New workflow" : `Edit ${form.workflow?.name}`}>
            {/* The key gives each workflow its own form state. */}
            <Builder
              key={form.workflow?.id ?? "new"}
              initial={form.workflow}
              onSaved={(w) => { patch(w); setForm(null); }}
              onCancel={() => setForm(null)}
            />
          </Card>
        </div>
      )}
      {list.length === 0 ? (
        <EmptyState
          title="No workflows yet"
          description={
            isAdmin
              ? "Build a step-based workflow to run projects deterministically, or start from the Reel template."
              : "Build a step-based workflow to run projects deterministically."
          }
        />
      ) : (
        <div className="space-y-3">
          {list.map((w) => {
            const counts = mediaCounts(w.steps);
            return (
              <Card key={w.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink">{w.name}</span>
                      <Badge tone="neutral">{w.steps.length} steps</Badge>
                      {counts && <Badge tone="signal">{counts}</Badge>}
                    </div>
                    {w.description && <p className="mt-0.5 text-xs text-ink-3">{w.description}</p>}
                    <ol className="mt-2 list-inside list-decimal text-xs text-ink-3">
                      {w.steps.slice(0, STEPS_SHOWN).map((s, i) => (
                        <li key={i}>
                          <span className="text-ink-2">{s.title}</span> · {s.role}
                          {s.kind && s.kind !== "text" ? ` · ${s.kind}` : ""}
                        </li>
                      ))}
                    </ol>
                    {w.steps.length > STEPS_SHOWN && (
                      <p className="mt-1 text-xs text-ink-3">and {w.steps.length - STEPS_SHOWN} more</p>
                    )}
                  </div>
                  {isAdmin && (
                    <div className="flex shrink-0 gap-2">
                      <Button variant="ghost" onClick={() => setForm({ mode: "edit", workflow: w })}>Edit</Button>
                      <Button variant="danger" loading={busy[w.id]} onClick={() => remove(w)}><Icon name="trash" /></Button>
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
