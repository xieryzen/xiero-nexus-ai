"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { MemoryDTO } from "@/lib/agent/memory";
import {
  DEFAULT_MAX_STEPS,
  MAX_MAX_STEPS,
  MIN_MAX_STEPS,
  TOOL_CATALOG,
  TOOL_GROUP_LABELS,
  type ToolGroup,
  type ToolName,
} from "@/lib/agent/catalog";
import type { AgentDTO } from "@/lib/workforce";
import { CAPABILITIES, CAPABILITY_LABELS } from "@/lib/capabilities";
import { apiFetch, ApiError } from "@/lib/client";
import { RelativeTime } from "@/components/time";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Select, Textarea, Toggle, cn } from "@/components/ui";
import { Icon } from "@/components/icons";

export interface ModelOption {
  id: string;
  label: string;
  /** False for a model whose provider cannot pass tools on (a custom HTTP API). */
  tools?: boolean;
}

/** A model that an agent is set to and that is not in the list: switched off, or failing its check. */
export interface SetModelOption {
  id: string;
  label: string;
  why: string;
}

/** The entry of a model list for what is set and not offered, so that the field shows the truth. */
function SetOption({ value, models, setModels }: { value: string; models: ModelOption[]; setModels: SetModelOption[] }) {
  if (!value || models.some((m) => m.id === value)) return null;
  const set = setModels.find((m) => m.id === value);
  return <option value={value}>{set ? `${set.label} (not offered: ${set.why})` : "A model that is no longer offered"}</option>;
}

/** What the server is set up for: which tools would work if an agent had them. */
export interface ToolSetup {
  sandbox: boolean;
  /** The search service's name, or null when none is configured. */
  search: string | null;
}

export interface CollectionOption {
  id: string;
  name: string;
}

export interface SkillOption {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

const GROUPS: ToolGroup[] = ["workspace", "execution", "web"];

function AgentForm({
  models,
  setModels,
  toolSetup,
  collections,
  skills,
  initial,
  onSaved,
  onCancel,
}: {
  models: ModelOption[];
  setModels: SetModelOption[];
  toolSetup: ToolSetup;
  collections: CollectionOption[];
  skills: SkillOption[];
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
  const [tools, setTools] = useState<Set<ToolName>>(new Set(initial?.tools ?? []));
  const [maxSteps, setMaxSteps] = useState(String(initial?.maxSteps ?? DEFAULT_MAX_STEPS));
  const [memoryEnabled, setMemoryEnabled] = useState(initial?.memoryEnabled ?? false);
  const [collectionIds, setCollectionIds] = useState<Set<string>>(new Set(initial?.collectionIds ?? []));
  const [skillIds, setSkillIds] = useState<Set<string>>(new Set(initial?.skillIds ?? []));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const usesTools = tools.size > 0 || memoryEnabled || collectionIds.size > 0;
  const primaryModel = models.find((m) => m.id === primary);
  const toggleTool = (name: ToolName) =>
    setTools((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const toggleGroup = (group: ToolGroup, on: boolean) =>
    setTools((prev) => {
      const next = new Set(prev);
      for (const tool of TOOL_CATALOG) {
        if (tool.group !== group) continue;
        if (on) next.add(tool.name);
        else next.delete(tool.name);
      }
      return next;
    });
  const available = (needs?: "sandbox" | "search") =>
    needs === "sandbox" ? toolSetup.sandbox : needs === "search" ? toolSetup.search !== null : true;

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
      tools: [...tools],
      maxSteps: Number(maxSteps) || DEFAULT_MAX_STEPS,
      memoryEnabled,
      collectionIds: [...collectionIds],
      skillIds: [...skillIds],
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
            <SetOption value={primary} models={models} setModels={setModels} />
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </Select>
        </Field>
        <Field label="Fallback model" htmlFor="a-fb" hint="Used if primary fails">
          <Select id="a-fb" value={fallback} onChange={(e) => setFallback(e.target.value)}>
            <option value="">— none —</option>
            <SetOption value={fallback} models={models} setModels={setModels} />
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </Select>
        </Field>
        <Field label="Temperature" htmlFor="a-temp">
          <Input id="a-temp" type="number" step="0.1" min={0} max={2} value={temperature} onChange={(e) => setTemperature(e.target.value)} />
        </Field>
      </div>

      <fieldset className="rounded-md border border-line p-4">
        <legend className="px-1 text-sm font-medium text-ink">Tools</legend>
        <p className="text-xs text-ink-3">
          What this agent may do while it works on a task, besides writing. With tools it works in steps:
          it calls a tool, reads the result and goes on, until it has its deliverable. Give an agent only
          what its role needs: every tool is something a model decides to use on its own.
        </p>
        <div className="mt-3 space-y-4">
          {GROUPS.map((group) => {
            const items = TOOL_CATALOG.filter((t) => t.group === group);
            const all = items.every((t) => tools.has(t.name));
            return (
              <div key={group}>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-ink-3">{TOOL_GROUP_LABELS[group]}</p>
                  <button type="button" className="text-xs text-signal hover:underline" onClick={() => toggleGroup(group, !all)}>
                    {all ? "None" : "All"}
                  </button>
                </div>
                <ul className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
                  {items.map((tool) => {
                    const works = available(tool.needs);
                    return (
                      <li key={tool.name}>
                        <label
                          className={cn(
                            "flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 text-sm transition",
                            tools.has(tool.name) ? "border-signal/50 bg-signal/10" : "border-line hover:border-ink-3",
                          )}
                        >
                          <input
                            type="checkbox"
                            className="mt-0.5 accent-current"
                            checked={tools.has(tool.name)}
                            onChange={() => toggleTool(tool.name)}
                          />
                          <span className="min-w-0">
                            <span className="font-medium text-ink">{tool.label}</span>
                            <span className="block text-xs text-ink-3">{tool.summary}</span>
                            {!works && (
                              <span className="mt-0.5 block text-xs text-warn">
                                {tool.needs === "sandbox"
                                  ? "Not set up on this server: needs a sandbox runner (SANDBOX_URL). Until then the agent does not get this tool."
                                  : "Not set up on this server: needs a search service (SEARCH_PROVIDER). Until then the agent does not get this tool."}
                              </span>
                            )}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>

        <div className="mt-4">
          <Field
            label="Skills"
            hint={
              skills.length === 0
                ? "No skill yet. Upload a SKILL.md or a .skill on the Skills page."
                : "A way of working, written down. The agent reads its skills with each task; a team's skills come on top."
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
                      skillIds.has(s.id) ? "border-signal/50 bg-signal/15 text-signal" : "border-line text-ink-2 hover:text-ink",
                      !s.enabled && "opacity-60",
                    )}
                  >
                    {s.name}
                    {!s.enabled && " (off)"}
                  </button>
                ))}
              </div>
            )}
          </Field>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field
            label="Knowledge"
            hint={
              collections.length === 0
                ? "No shared collection yet. Make one on the Knowledge page and set it to Shared."
                : "The agent can search these collections while it works."
            }
          >
            {collections.length > 0 && (
              <ul className="space-y-1">
                {collections.map((c) => (
                  <li key={c.id}>
                    <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-2">
                      <input
                        type="checkbox"
                        className="accent-current"
                        checked={collectionIds.has(c.id)}
                        onChange={() =>
                          setCollectionIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(c.id)) next.delete(c.id);
                            else next.add(c.id);
                            return next;
                          })
                        }
                      />
                      {c.name}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </Field>
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="label">Memory</p>
                <p className="text-xs text-ink-3">
                  The agent can keep short notes and gets them back in later tasks. Notes stay with the person
                  whose project they were written in.
                </p>
              </div>
              <Toggle checked={memoryEnabled} onChange={setMemoryEnabled} label="Memory" />
            </div>
            <Field label="Steps per task" htmlFor="a-steps" hint={`Most model calls one task may take, the answer included (${MIN_MAX_STEPS}–${MAX_MAX_STEPS}).`}>
              <Input id="a-steps" type="number" min={MIN_MAX_STEPS} max={MAX_MAX_STEPS} value={maxSteps} onChange={(e) => setMaxSteps(e.target.value)} disabled={!usesTools} />
            </Field>
          </div>
        </div>

        {usesTools && primaryModel?.tools === false && (
          <div className="mt-3">
            <Alert tone="warn">
              The primary model is on a provider that cannot pass tools on (a custom HTTP API). With that model
              the agent answers without tools.
            </Alert>
          </div>
        )}
      </fieldset>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" loading={loading}>{editing ? "Save changes" : "Add agent"}</Button>
      </div>
    </form>
  );
}

/** The notes an agent has kept: a user's own, or everybody's for an administrator. */
function MemoryPanel({
  agent,
  isAdmin,
  onCount,
  onClose,
}: {
  agent: AgentDTO;
  isAdmin: boolean;
  onCount: (n: number) => void;
  onClose: () => void;
}) {
  const [notes, setNotes] = useState<MemoryDTO[] | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const data = await apiFetch<{ memories: MemoryDTO[] }>(`/api/agents/${agent.id}/memories`);
      setNotes(data.memories);
      onCount(data.memories.length);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the notes");
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/agents/${agent.id}/memories`, { method: "POST", body: JSON.stringify({ content: draft }) });
      setDraft("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add the note");
    } finally {
      setBusy(false);
    }
  }

  async function remove(note: MemoryDTO) {
    try {
      await apiFetch(`/api/agents/${agent.id}/memories/${note.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete the note");
    }
  }

  async function clearAll() {
    if (!confirm(isAdmin ? `Delete every note of "${agent.name}", for all users?` : `Delete your notes of "${agent.name}"?`)) return;
    try {
      await apiFetch(`/api/agents/${agent.id}/memories`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete the notes");
    }
  }

  return (
    <div className="mt-3 rounded-md border border-line bg-surface-2/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-ink">What {agent.name} remembers</p>
          <p className="text-xs text-ink-3">
            {isAdmin
              ? "Notes from everyone's projects, and notes added here, which apply in all projects."
              : "Notes from your projects, and notes an administrator added for everyone."}
            {!agent.memoryEnabled && " Memory is switched off for this agent, so it neither adds notes nor gets them."}
          </p>
        </div>
        <button type="button" className="btn-ghost p-1.5" onClick={onClose} aria-label="Close">
          <Icon name="x" size={16} />
        </button>
      </div>
      {error && (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
      {notes === null ? (
        <p className="mt-3 text-sm text-ink-3">Loading…</p>
      ) : notes.length === 0 ? (
        <p className="mt-3 text-sm text-ink-3">No notes yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {notes.map((note) => (
            <li key={note.id} className="flex items-start justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="text-sm text-ink">{note.content}</p>
                <p className="mt-0.5 text-[11px] text-ink-3">
                  {note.source === "manual" ? "added by an administrator, for everyone" : isAdmin ? `from ${note.owner}'s project` : "from your project"}
                  {" · "}
                  <RelativeTime at={note.createdAt} />
                </p>
              </div>
              {(isAdmin || note.source === "agent") && (
                <button type="button" className="btn-ghost p-1.5 text-ink-3 hover:text-danger" onClick={() => remove(note)} aria-label="Delete note">
                  <Icon name="trash" size={15} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
        {isAdmin ? (
          <form onSubmit={add} className="flex min-w-0 flex-1 items-end gap-2">
            <div className="min-w-0 flex-1">
              <Input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={1000} placeholder="Add a note for everyone, e.g. “Prices are always in rupiah.”" aria-label="New note" />
            </div>
            <Button type="submit" variant="ghost" loading={busy} disabled={!draft.trim()}>
              Add
            </Button>
          </form>
        ) : (
          <span />
        )}
        {notes !== null && notes.length > 0 && (
          <button type="button" className="text-xs text-ink-3 hover:text-danger" onClick={clearAll}>
            {isAdmin ? "Delete all notes" : "Delete my notes"}
          </button>
        )}
      </div>
    </div>
  );
}

export function AgentsManager({
  initialAgents,
  models,
  setModels = [],
  toolSetup,
  collections,
  skills,
  isAdmin,
}: {
  initialAgents: AgentDTO[];
  models: ModelOption[];
  /** Models that agents are set to and that are not in `models`. */
  setModels?: SetModelOption[];
  toolSetup: ToolSetup;
  collections: CollectionOption[];
  skills: SkillOption[];
  isAdmin: boolean;
}) {
  const [list, setList] = useState(initialAgents);
  const [form, setForm] = useState<{ mode: "new" | "edit"; agent?: AgentDTO } | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [memoryOf, setMemoryOf] = useState<string | null>(null);
  const collectionName = new Map(collections.map((c) => [c.id, c.name] as const));
  const skillName = new Map(skills.map((s) => [s.id, s.name] as const));

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
      description="Configurable specialists. Each has a role, instructions, model(s), and the tools it may use."
      actions={isAdmin && !form ? <Button onClick={() => setForm({ mode: "new" })}><Icon name="plus" /> Add agent</Button> : undefined}
    >
      {form && (
        <div className="mb-5 rounded-md border border-line bg-surface-2/40 p-4">
          <AgentForm
            models={models}
            setModels={setModels}
            toolSetup={toolSetup}
            collections={collections}
            skills={skills}
            initial={form.agent}
            onSaved={(a) => { patch(a); setForm(null); }}
            onCancel={() => setForm(null)}
          />
        </div>
      )}

      {(!toolSetup.sandbox || toolSetup.search === null) && isAdmin && list.some((a) => a.tools.length > 0) && (
        <p className="mb-3 text-xs text-ink-3">
          {!toolSetup.sandbox && "Running commands needs a sandbox runner (SANDBOX_URL). "}
          {toolSetup.search === null && "Searching the web needs a search service (SEARCH_PROVIDER). "}
          Agents get the other tools they were given. See the <Link href="/dashboard/observability" className="text-signal hover:underline">server status</Link>.
        </p>
      )}
      {list.length === 0 ? (
        <EmptyState title="No agents yet" description="Create agents to assign work to during orchestration." />
      ) : (
        <ul className="divide-y divide-line">
          {list.map((a) => (
            <li key={a.id} className="py-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">{a.name}</span>
                    <Badge tone="info">{a.role}</Badge>
                    <Badge tone={a.status === "active" ? "ok" : "neutral"}>{a.status}</Badge>
                    {a.tools.length > 0 && (
                      <span title={a.tools.join(", ")}>
                        <Badge tone="signal">
                          <Icon name="tool" size={12} /> {a.tools.length} {a.tools.length === 1 ? "tool" : "tools"}
                        </Badge>
                      </span>
                    )}
                    {a.collectionIds.length > 0 && (
                      <span title={a.collectionIds.map((id) => collectionName.get(id) ?? "a collection").join(", ")}>
                        <Badge tone="signal">
                          <Icon name="knowledge" size={12} /> knowledge
                        </Badge>
                      </span>
                    )}
                    {a.memoryEnabled && (
                      <Badge tone="signal">
                        <Icon name="memory" size={12} /> memory
                      </Badge>
                    )}
                    {a.skillIds.length > 0 && (
                      <span title={a.skillIds.map((id) => skillName.get(id) ?? "a skill").join(", ")}>
                        <Badge tone="signal">
                          <Icon name="skill" size={12} /> {a.skillIds.length} {a.skillIds.length === 1 ? "skill" : "skills"}
                        </Badge>
                      </span>
                    )}
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
                    {(a.tools.length > 0 || a.memoryEnabled || a.collectionIds.length > 0) && (
                      <span> · up to {a.maxSteps} steps per task</span>
                    )}
                  </p>
                </div>
                <div className="flex gap-2">
                  {(a.memoryEnabled || a.memoryCount > 0) && (
                    <Button variant="ghost" onClick={() => setMemoryOf(memoryOf === a.id ? null : a.id)} aria-expanded={memoryOf === a.id}>
                      <Icon name="memory" /> Notes{a.memoryCount > 0 ? ` (${a.memoryCount})` : ""}
                    </Button>
                  )}
                  {isAdmin && (
                    <>
                      <Button variant="ghost" onClick={() => setForm({ mode: "edit", agent: a })}>Edit</Button>
                      <Button variant="danger" loading={busy[a.id]} onClick={() => remove(a)} aria-label={`Delete ${a.name}`}><Icon name="trash" /></Button>
                    </>
                  )}
                </div>
              </div>
              {memoryOf === a.id && (
                <MemoryPanel
                  agent={a}
                  isAdmin={isAdmin}
                  onCount={(n) => setList((l) => l.map((x) => (x.id === a.id ? { ...x, memoryCount: n } : x)))}
                  onClose={() => setMemoryOf(null)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
