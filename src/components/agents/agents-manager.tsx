"use client";

import { useState } from "react";
import type { AgentDTO } from "@/lib/workforce";
import { CAPABILITIES, CAPABILITY_LABELS } from "@/lib/capabilities";
import { apiFetch, ApiError } from "@/lib/client";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Select, Textarea } from "@/components/ui";
import { Icon } from "@/components/icons";

export interface ModelOption {
  id: string;
  label: string;
}

function AgentForm({
  models,
  initial,
  onSaved,
  onCancel,
}: {
  models: ModelOption[];
  initial?: AgentDTO;
  onSaved: (a: AgentDTO) => void;
  onCancel: () => void;
}) {
  const editing = Boolean(initial);
  const [name, setName] = useState(initial?.name ?? "");
  const [role, setRole] = useState(initial?.role ?? "");
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [primary, setPrimary] = useState(initial?.primaryModelRowId ?? "");
  const [fallback, setFallback] = useState(initial?.fallbackModelRowId ?? "");
  const [routingMode, setRoutingMode] = useState<"manual" | "auto">(initial?.routingMode ?? "manual");
  const [reqCap, setReqCap] = useState(initial?.requiredCapability ?? "");
  const [temperature, setTemperature] = useState(String(initial?.temperature ?? 0.7));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const payload = {
      name,
      role,
      instructions,
      primaryModelRowId: primary || null,
      fallbackModelRowId: fallback || null,
      routingMode,
      requiredCapability: routingMode === "auto" && reqCap ? reqCap : null,
      temperature: Number(temperature),
    };
    try {
      const res = editing
        ? await apiFetch<{ agent: AgentDTO }>(`/api/agents/${initial!.id}`, { method: "PATCH", body: JSON.stringify(payload) })
        : await apiFetch<{ agent: AgentDTO }>("/api/agents", { method: "POST", body: JSON.stringify(payload) });
      onSaved(res.agent);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save agent");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="a-name">
          <Input id="a-name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Ada" />
        </Field>
        <Field label="Role" htmlFor="a-role">
          <Input id="a-role" value={role} onChange={(e) => setRole(e.target.value)} required placeholder="Backend Engineer" />
        </Field>
      </div>
      <Field label="Instructions" htmlFor="a-inst" hint="System prompt that defines this agent's behavior.">
        <Textarea id="a-inst" value={instructions} onChange={(e) => setInstructions(e.target.value)} className="min-h-[90px]" placeholder="You are a precise backend engineer who…" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Model routing" htmlFor="a-route" hint={routingMode === "auto" ? "Cheapest matching model is chosen per run." : "Uses the primary model (then fallback)."}>
          <Select id="a-route" value={routingMode} onChange={(e) => setRoutingMode(e.target.value as "manual" | "auto")}>
            <option value="manual">Manual (use primary/fallback)</option>
            <option value="auto">Automatic (cheapest)</option>
          </Select>
        </Field>
        {routingMode === "auto" && (
          <Field label="Require capability" htmlFor="a-cap" hint="Optional — restrict auto-pick to models with this capability.">
            <Select id="a-cap" value={reqCap} onChange={(e) => setReqCap(e.target.value)}>
              <option value="">Any</option>
              {CAPABILITIES.map((c) => (
                <option key={c} value={c}>{CAPABILITY_LABELS[c]}</option>
              ))}
            </Select>
          </Field>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Primary model" htmlFor="a-pri">
          <Select id="a-pri" value={primary} onChange={(e) => setPrimary(e.target.value)}>
            <option value="">— none —</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </Select>
        </Field>
        <Field label="Fallback model" htmlFor="a-fb" hint="Used if primary fails">
          <Select id="a-fb" value={fallback} onChange={(e) => setFallback(e.target.value)}>
            <option value="">— none —</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </Select>
        </Field>
        <Field label="Temperature" htmlFor="a-temp">
          <Input id="a-temp" type="number" step="0.1" min={0} max={2} value={temperature} onChange={(e) => setTemperature(e.target.value)} />
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" loading={loading}>{editing ? "Save changes" : "Add agent"}</Button>
      </div>
    </form>
  );
}

export function AgentsManager({
  initialAgents,
  models,
  isAdmin,
}: {
  initialAgents: AgentDTO[];
  models: ModelOption[];
  isAdmin: boolean;
}) {
  const [list, setList] = useState(initialAgents);
  const [form, setForm] = useState<{ mode: "new" | "edit"; agent?: AgentDTO } | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  function patch(a: AgentDTO) {
    setList((l) => {
      const i = l.findIndex((x) => x.id === a.id);
      if (i === -1) return [...l, a];
      const n = [...l];
      n[i] = a;
      return n;
    });
  }

  async function remove(a: AgentDTO) {
    if (!confirm(`Delete agent "${a.name}"?`)) return;
    setBusy((b) => ({ ...b, [a.id]: true }));
    try {
      await apiFetch(`/api/agents/${a.id}`, { method: "DELETE" });
      setList((l) => l.filter((x) => x.id !== a.id));
    } catch {
      setBusy((b) => ({ ...b, [a.id]: false }));
    }
  }

  return (
    <Card
      title="Agents"
      description="Configurable specialists. Each has a role, instructions, and model(s)."
      actions={isAdmin && !form ? <Button onClick={() => setForm({ mode: "new" })}><Icon name="plus" /> Add agent</Button> : undefined}
    >
      {form && (
        <div className="mb-5 rounded-md border border-line bg-surface-2/40 p-4">
          <AgentForm
            models={models}
            initial={form.agent}
            onSaved={(a) => { patch(a); setForm(null); }}
            onCancel={() => setForm(null)}
          />
        </div>
      )}

      {list.length === 0 ? (
        <EmptyState title="No agents yet" description="Create agents to assign work to during orchestration." />
      ) : (
        <ul className="divide-y divide-line">
          {list.map((a) => (
            <li key={a.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{a.name}</span>
                  <Badge tone="info">{a.role}</Badge>
                  <Badge tone={a.status === "active" ? "ok" : "neutral"}>{a.status}</Badge>
                </div>
                <p className="mt-1 text-xs text-ink-3">
                  {a.routingMode === "auto" ? (
                    <span className="text-signal">auto-routed{a.requiredCapability ? ` · needs ${a.requiredCapability}` : ""}</span>
                  ) : a.primaryModelLabel ? (
                    <span className="mono">{a.primaryModelLabel}</span>
                  ) : (
                    <span className="text-warn">no model</span>
                  )}
                  {a.fallbackModelLabel && <span className="mono"> · fallback {a.fallbackModelLabel}</span>}
                  <span> · temp {a.temperature}</span>
                </p>
              </div>
              {isAdmin && (
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => setForm({ mode: "edit", agent: a })}>Edit</Button>
                  <Button variant="danger" loading={busy[a.id]} onClick={() => remove(a)}><Icon name="trash" /></Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
