"use client";

import { useState } from "react";
import type { TeamDTO } from "@/lib/workforce";
import { apiFetch, ApiError } from "@/lib/client";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, cn } from "@/components/ui";
import { Icon } from "@/components/icons";

export interface AgentLite {
  id: string;
  name: string;
  role: string;
}

export interface SkillLite {
  id: string;
  name: string;
  description: string;
}

function TeamForm({
  agents,
  skills,
  initial,
  onSaved,
  onCancel,
}: {
  agents: AgentLite[];
  skills: SkillLite[];
  initial?: TeamDTO;
  onSaved: (t: TeamDTO) => void;
  onCancel: () => void;
}) {
  const editing = Boolean(initial);
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [members, setMembers] = useState<Set<string>>(new Set(initial?.agentIds ?? []));
  const [skillIds, setSkillIds] = useState<Set<string>>(new Set(initial?.skillIds ?? []));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function toggle(id: string) {
    setMembers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const payload = { name, description: description || undefined, agentIds: [...members], skillIds: [...skillIds] };
    try {
      const res = editing
        ? await apiFetch<{ team: TeamDTO }>(`/api/teams/${initial!.id}`, { method: "PATCH", body: JSON.stringify(payload) })
        : await apiFetch<{ team: TeamDTO }>("/api/teams", { method: "POST", body: JSON.stringify(payload) });
      onSaved(res.team);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save team");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="t-name">
          <Input id="t-name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Build Squad" />
        </Field>
        <Field label="Description" htmlFor="t-desc">
          <Input id="t-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="optional" />
        </Field>
      </div>
      <Field label="Members">
        {agents.length === 0 ? (
          <p className="text-sm text-ink-3">Create agents first.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {agents.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => toggle(a.id)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium transition",
                  members.has(a.id) ? "border-accent/60 bg-accent-soft text-accent-ink" : "border-line text-ink-2 hover:text-ink",
                )}
              >
                {a.name} · {a.role}
              </button>
            ))}
          </div>
        )}
      </Field>
      <Field
        label="Skills of the team"
        hint={
          skills.length === 0
            ? "No skill yet. Upload a SKILL.md or a .skill on the Skills page."
            : "Every member works by these in a project of this team, on top of its own skills."
        }
      >
        {skills.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {skills.map((s) => (
              <button
                key={s.id}
                type="button"
                title={s.description || undefined}
                aria-pressed={skillIds.has(s.id)}
                onClick={() =>
                  setSkillIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(s.id)) next.delete(s.id);
                    else next.add(s.id);
                    return next;
                  })
                }
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium transition",
                  skillIds.has(s.id) ? "border-accent/60 bg-accent-soft text-accent-ink" : "border-line text-ink-2 hover:text-ink",
                )}
              >
                {s.name}
              </button>
            ))}
          </div>
        )}
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" loading={loading}>{editing ? "Save changes" : "Create team"}</Button>
      </div>
    </form>
  );
}

export function TeamsManager({
  initialTeams,
  agents,
  skills,
  isAdmin,
}: {
  initialTeams: TeamDTO[];
  agents: AgentLite[];
  skills: SkillLite[];
  isAdmin: boolean;
}) {
  const [list, setList] = useState(initialTeams);
  const [form, setForm] = useState<{ mode: "new" | "edit"; team?: TeamDTO } | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const nameById = new Map(agents.map((a) => [a.id, a.name] as const));
  const skillById = new Map(skills.map((s) => [s.id, s.name] as const));

  function patch(t: TeamDTO) {
    setList((l) => {
      const i = l.findIndex((x) => x.id === t.id);
      if (i === -1) return [...l, t];
      const n = [...l];
      n[i] = t;
      return n;
    });
  }

  async function remove(t: TeamDTO) {
    if (!confirm(`Delete team "${t.name}"?`)) return;
    setBusy((b) => ({ ...b, [t.id]: true }));
    try {
      await apiFetch(`/api/teams/${t.id}`, { method: "DELETE" });
      setList((l) => l.filter((x) => x.id !== t.id));
    } catch {
      setBusy((b) => ({ ...b, [t.id]: false }));
    }
  }

  return (
    <Card
      title="Teams"
      description="Group agents into a workforce you can assign to a project."
      actions={isAdmin && !form ? <Button onClick={() => setForm({ mode: "new" })}><Icon name="plus" /> New team</Button> : undefined}
    >
      {form && (
        <div className="mb-5 rounded-md border border-line bg-surface-2/40 p-4">
          <TeamForm agents={agents} skills={skills} initial={form.team} onSaved={(t) => { patch(t); setForm(null); }} onCancel={() => setForm(null)} />
        </div>
      )}
      {list.length === 0 ? (
        <EmptyState title="No teams yet" description="A project can also run with all active agents if you skip teams." />
      ) : (
        <ul className="divide-y divide-line">
          {list.map((t) => (
            <li key={t.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-ink">{t.name}</span>
                  <Badge tone="neutral">{t.agentIds.length} agents</Badge>
                  {t.skillIds.length > 0 && (
                    <span title={t.skillIds.map((id) => skillById.get(id) ?? "a skill").join(", ")}>
                      <Badge tone="signal">
                        <Icon name="skill" size={12} /> {t.skillIds.length} {t.skillIds.length === 1 ? "skill" : "skills"}
                      </Badge>
                    </span>
                  )}
                </div>
                {t.description && <p className="mt-0.5 text-xs text-ink-3">{t.description}</p>}
                <p className="mt-1 text-xs text-ink-3">{t.agentIds.map((id) => nameById.get(id) ?? "?").join(", ") || "—"}</p>
              </div>
              {isAdmin && (
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => setForm({ mode: "edit", team: t })}>Edit</Button>
                  <Button variant="danger" loading={busy[t.id]} onClick={() => remove(t)}><Icon name="trash" /></Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
