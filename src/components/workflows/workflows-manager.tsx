"use client";

import { useState } from "react";
import type { WorkflowDTO } from "@/lib/workforce";
import { apiFetch, ApiError } from "@/lib/client";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, PageHeader, Textarea } from "@/components/ui";
import { Icon } from "@/components/icons";

interface StepForm {
  title: string;
  objective: string;
  role: string;
  outputFile: string;
  dependsOn: string; // csv of seq numbers
}

const emptyStep: StepForm = { title: "", objective: "", role: "", outputFile: "", dependsOn: "" };

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
    initial?.steps.length
      ? initial.steps.map((s) => ({
          title: s.title,
          objective: s.objective,
          role: s.role,
          outputFile: s.outputFile ?? "",
          dependsOn: (s.dependsOn ?? []).join(","),
        }))
      : [{ ...emptyStep }],
  );
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
      return n;
    });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const payloadSteps = steps
      .filter((s) => s.title.trim() && s.objective.trim() && s.role.trim())
      .map((s) => ({
        title: s.title.trim(),
        objective: s.objective.trim(),
        role: s.role.trim(),
        outputFile: s.outputFile.trim() || undefined,
        dependsOn: s.dependsOn
          .split(",")
          .map((x) => parseInt(x.trim(), 10))
          .filter((n) => Number.isFinite(n)),
      }));
    try {
      const res = editing
        ? await apiFetch<{ workflow: WorkflowDTO }>(`/api/workflows/${initial!.id}`, { method: "PATCH", body: JSON.stringify({ name, description: description || undefined, steps: payloadSteps }) })
        : await apiFetch<{ workflow: WorkflowDTO }>("/api/workflows", { method: "POST", body: JSON.stringify({ name, description: description || undefined, steps: payloadSteps }) });
      onSaved(res.workflow);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save workflow");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="w-name">
          <Input id="w-name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Spec → Build → Review" />
        </Field>
        <Field label="Description" htmlFor="w-desc">
          <Input id="w-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="optional" />
        </Field>
      </div>

      <div className="space-y-3">
        {steps.map((s, i) => (
          <div key={i} className="rounded-md border border-line bg-surface-2/40 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold text-ink-3">Step {i + 1}</span>
              <div className="flex gap-1">
                <button type="button" onClick={() => move(i, -1)} className="btn-ghost px-2 py-1 text-xs" aria-label="Move up">↑</button>
                <button type="button" onClick={() => move(i, 1)} className="btn-ghost px-2 py-1 text-xs" aria-label="Move down">↓</button>
                <button type="button" onClick={() => setSteps((st) => st.filter((_, idx) => idx !== i))} className="btn-ghost px-2 py-1 text-xs text-danger" aria-label="Remove">✕</button>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Input value={s.title} onChange={(e) => update(i, { title: e.target.value })} placeholder="Title" />
              <Input value={s.role} onChange={(e) => update(i, { role: e.target.value })} placeholder="Agent role (e.g. Engineer)" />
            </div>
            <Textarea value={s.objective} onChange={(e) => update(i, { objective: e.target.value })} placeholder="Objective" className="mt-2 min-h-[56px]" />
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <Input value={s.outputFile} onChange={(e) => update(i, { outputFile: e.target.value })} placeholder="Output file (optional, e.g. src/x.ts)" className="mono" />
              <Input value={s.dependsOn} onChange={(e) => update(i, { dependsOn: e.target.value })} placeholder="Depends on steps (e.g. 1,2)" />
            </div>
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
            <Builder initial={form.workflow} onSaved={(w) => { patch(w); setForm(null); }} onCancel={() => setForm(null)} />
          </Card>
        </div>
      )}
      {list.length === 0 ? (
        <EmptyState title="No workflows yet" description="Build a step-based workflow to run projects deterministically." />
      ) : (
        <div className="space-y-3">
          {list.map((w) => (
            <Card key={w.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-ink">{w.name}</span>
                    <Badge tone="neutral">{w.steps.length} steps</Badge>
                  </div>
                  {w.description && <p className="mt-0.5 text-xs text-ink-3">{w.description}</p>}
                  <ol className="mt-2 list-inside list-decimal text-xs text-ink-3">
                    {w.steps.slice(0, 6).map((s, i) => (
                      <li key={i}><span className="text-ink-2">{s.title}</span> · {s.role}</li>
                    ))}
                  </ol>
                </div>
                {isAdmin && (
                  <div className="flex shrink-0 gap-2">
                    <Button variant="ghost" onClick={() => setForm({ mode: "edit", workflow: w })}>Edit</Button>
                    <Button variant="danger" loading={busy[w.id]} onClick={() => remove(w)}><Icon name="trash" /></Button>
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
