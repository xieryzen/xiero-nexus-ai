"use client";

import { useRef, useState } from "react";
import { apiFetch, apiUpload, ApiError } from "@/lib/client";
import {
  SKILL_DESCRIPTION_MAX,
  SKILL_INSTRUCTIONS_MAX,
  SKILL_NAME_MAX,
  SKILL_UPLOAD_MAX_BYTES,
} from "@/lib/skills/limits";
import type { SkillDTO } from "@/lib/skills/service";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Textarea, Toggle, cn } from "@/components/ui";
import { Icon } from "@/components/icons";

interface Named {
  id: string;
  name: string;
}

type UploadedSkill = SkillDTO & { replaced: boolean };

const ACCEPT = ".md,.markdown,.mdx,.txt,.skill,.zip,.json";

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

function SkillForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial?: SkillDTO;
  onSaved: (skill: SkillDTO) => void;
  onCancel: () => void;
}) {
  const editing = Boolean(initial);
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = editing
        ? await apiFetch<{ skill: SkillDTO }>(`/api/skills/${initial!.id}`, {
            method: "PATCH",
            body: JSON.stringify({ name, description, instructions }),
          })
        : await apiFetch<{ skill: SkillDTO }>("/api/skills", {
            method: "POST",
            body: JSON.stringify({ name, description, instructions }),
          });
      onSaved(res.skill);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the skill");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Name" htmlFor="skill-name">
        <Input
          id="skill-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={SKILL_NAME_MAX}
          placeholder="e.g. minecraft-paper-plugin"
        />
      </Field>
      <Field
        label="Description"
        htmlFor="skill-description"
        hint="What the skill is for and when it applies. The one who plans the work reads this."
      >
        <Textarea
          id="skill-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          maxLength={SKILL_DESCRIPTION_MAX}
        />
      </Field>
      <Field
        label="Instructions"
        htmlFor="skill-instructions"
        hint="Markdown, as in a SKILL.md: the steps, the rules, what a good result looks like, what to avoid."
      >
        <Textarea
          id="skill-instructions"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={16}
          maxLength={SKILL_INSTRUCTIONS_MAX}
          className="mono"
        />
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={loading}>
          {editing ? "Save changes" : "Add skill"}
        </Button>
      </div>
    </form>
  );
}

function SkillDetail({ skill, isAdmin, onEdit }: { skill: SkillDTO; isAdmin: boolean; onEdit: () => void }) {
  const [file, setFile] = useState<{ path: string; content: string } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  async function open(path: string) {
    setFileError(null);
    if (file?.path === path) {
      setFile(null);
      return;
    }
    try {
      setFile(await apiFetch<{ path: string; content: string }>(`/api/skills/${skill.id}/files?path=${encodeURIComponent(path)}`));
    } catch (err) {
      setFileError(err instanceof ApiError ? err.message : "Could not read the file");
    }
  }

  return (
    <div className="mt-3 space-y-3 rounded-md border border-line bg-surface-2/40 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-3">Instructions</p>
        <div className="flex gap-2">
          {isAdmin && (
            <Button variant="ghost" onClick={onEdit}>
              Edit
            </Button>
          )}
          <a className="btn-ghost" href={`/api/skills/${skill.id}/download?format=md`}>
            <Icon name="download" /> SKILL.md
          </a>
          <a className="btn-ghost" href={`/api/skills/${skill.id}/download`}>
            <Icon name="download" /> .skill
          </a>
        </div>
      </div>
      <pre className="mono max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs text-ink-2">
        {skill.instructions || "(no instructions: the description is all there is)"}
      </pre>
      {skill.files.length > 0 && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-ink-3">Files</p>
          <ul className="mt-1 flex flex-wrap gap-2">
            {skill.files.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  onClick={() => open(f.path)}
                  aria-expanded={file?.path === f.path}
                  className={cn(
                    "mono rounded border px-2 py-1 text-xs transition",
                    file?.path === f.path ? "border-signal/50 bg-signal/15 text-signal" : "border-line text-ink-2 hover:text-ink",
                  )}
                >
                  {f.path} · {kb(f.sizeBytes)}
                </button>
              </li>
            ))}
          </ul>
          {fileError && <p className="mt-2 text-xs text-danger">{fileError}</p>}
          {file && (
            <pre className="mono mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border border-line p-3 text-xs text-ink-2">
              {file.content}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function SkillsManager({
  initialSkills,
  agents,
  teams,
  isAdmin,
}: {
  initialSkills: SkillDTO[];
  agents: Named[];
  teams: Named[];
  isAdmin: boolean;
}) {
  const [list, setList] = useState(initialSkills);
  const [form, setForm] = useState<{ mode: "new" | "edit"; skill?: SkillDTO } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [replace, setReplace] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notes, setNotes] = useState<{ tone: "ok" | "danger" | "warn"; text: string }[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const agentName = new Map(agents.map((a) => [a.id, a.name] as const));
  const teamName = new Map(teams.map((t) => [t.id, t.name] as const));

  function put(skill: SkillDTO) {
    setList((l) => {
      const next = l.filter((x) => x.id !== skill.id);
      next.push(skill);
      return next.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    });
  }

  async function upload(files: FileList | File[]) {
    const chosen = [...files];
    if (chosen.length === 0) return;
    setUploading(true);
    const said: { tone: "ok" | "danger" | "warn"; text: string }[] = [];
    for (const file of chosen) {
      if (file.size > SKILL_UPLOAD_MAX_BYTES) {
        said.push({ tone: "danger", text: `${file.name}: larger than ${Math.floor(SKILL_UPLOAD_MAX_BYTES / (1024 * 1024))} MB.` });
        continue;
      }
      try {
        const res = await apiUpload<{ skills: UploadedSkill[]; leftOut: string[] }>(
          `/api/skills/upload${replace ? "?onConflict=replace" : ""}`,
          file,
        );
        for (const skill of res.skills) {
          put(skill);
          said.push({
            tone: "ok",
            text: `${file.name}: "${skill.name}" ${skill.replaced ? "replaced" : "added"}${skill.files.length ? `, with ${skill.files.length} file${skill.files.length === 1 ? "" : "s"}` : ""}.`,
          });
        }
        if (res.leftOut.length > 0) {
          said.push({
            tone: "warn",
            text: `${file.name}: left out, ${res.leftOut.slice(0, 6).join("; ")}${res.leftOut.length > 6 ? `; and ${res.leftOut.length - 6} more` : ""}.`,
          });
        }
      } catch (err) {
        said.push({ tone: "danger", text: `${file.name}: ${err instanceof ApiError ? err.message : "the upload failed"}` });
      }
    }
    setNotes(said);
    setUploading(false);
    if (input.current) input.current.value = "";
  }

  async function show(skill: SkillDTO) {
    if (openId === skill.id) {
      setOpenId(null);
      return;
    }
    setOpenId(skill.id);
    if (skill.instructions === undefined) {
      try {
        const res = await apiFetch<{ skill: SkillDTO }>(`/api/skills/${skill.id}`);
        put(res.skill);
      } catch {
        /* the row stays as it is; the detail says there is nothing */
      }
    }
  }

  async function edit(skill: SkillDTO) {
    try {
      const res = await apiFetch<{ skill: SkillDTO }>(`/api/skills/${skill.id}`);
      put(res.skill);
      setForm({ mode: "edit", skill: res.skill });
    } catch (err) {
      setNotes([{ tone: "danger", text: err instanceof ApiError ? err.message : "Could not read the skill" }]);
    }
  }

  async function setEnabled(skill: SkillDTO, enabled: boolean) {
    setBusy((b) => ({ ...b, [skill.id]: true }));
    try {
      const res = await apiFetch<{ skill: SkillDTO }>(`/api/skills/${skill.id}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
      put(res.skill);
    } catch (err) {
      setNotes([{ tone: "danger", text: err instanceof ApiError ? err.message : "Could not change the skill" }]);
    }
    setBusy((b) => ({ ...b, [skill.id]: false }));
  }

  async function remove(skill: SkillDTO) {
    const users = skill.agentIds.length + skill.teamIds.length;
    if (!confirm(`Delete the skill "${skill.name}"?${users ? ` ${users} agent${users === 1 ? "" : "s"} or team${users === 1 ? "" : "s"} will lose it.` : ""}`)) return;
    setBusy((b) => ({ ...b, [skill.id]: true }));
    try {
      await apiFetch(`/api/skills/${skill.id}`, { method: "DELETE" });
      setList((l) => l.filter((x) => x.id !== skill.id));
    } catch (err) {
      setNotes([{ tone: "danger", text: err instanceof ApiError ? err.message : "Could not delete the skill" }]);
      setBusy((b) => ({ ...b, [skill.id]: false }));
    }
  }

  return (
    <div className="space-y-6">
      {isAdmin && (
        <Card
          title="Add a skill"
          description="Upload a SKILL.md, a .skill or a .zip of a skill folder (a SKILL.md and the files it refers to), or write one here."
          actions={
            !form ? (
              <Button variant="ghost" onClick={() => setForm({ mode: "new" })}>
                <Icon name="plus" /> Write a skill
              </Button>
            ) : undefined
          }
        >
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void upload(e.dataTransfer.files);
            }}
            className={cn(
              "flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-8 text-center transition",
              dragging ? "border-signal bg-signal/10" : "border-line",
            )}
          >
            <p className="text-sm text-ink-2">
              Drop files here: <span className="mono">SKILL.md</span>, <span className="mono">.skill</span>,{" "}
              <span className="mono">.zip</span>, Markdown, text or JSON. Up to {Math.floor(SKILL_UPLOAD_MAX_BYTES / (1024 * 1024))} MB each.
            </p>
            <input
              ref={input}
              id="skill-files"
              type="file"
              multiple
              accept={ACCEPT}
              className="sr-only"
              onChange={(e) => e.target.files && void upload(e.target.files)}
            />
            <Button loading={uploading} onClick={() => input.current?.click()}>
              <Icon name="upload" /> Choose files
            </Button>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-2">
              <input type="checkbox" className="accent-current" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
              Replace a skill of the same name (it stays with its agents and teams)
            </label>
          </div>
          {notes.length > 0 && (
            <div className="mt-4 space-y-2">
              {notes.map((n, i) => (
                <Alert key={i} tone={n.tone}>
                  {n.text}
                </Alert>
              ))}
            </div>
          )}
          {form && (
            <div className="mt-5 rounded-md border border-line bg-surface-2/40 p-4">
              <SkillForm
                initial={form.skill}
                onSaved={(skill) => {
                  put(skill);
                  setForm(null);
                  setOpenId(skill.id);
                }}
                onCancel={() => setForm(null)}
              />
            </div>
          )}
        </Card>
      )}

      <Card title="Skills" description="Give a skill to an agent or to a team on the Agents page.">
        {list.length === 0 ? (
          <EmptyState
            title="No skills yet"
            description="A skill says how a kind of work is done here: the steps, the rules, what to avoid. Agents that have it follow it."
          />
        ) : (
          <ul className="divide-y divide-line">
            {list.map((skill) => {
              const usedBy = [
                ...skill.agentIds.map((id) => agentName.get(id) ?? "an agent"),
                ...skill.teamIds.map((id) => `${teamName.get(id) ?? "a team"} (team)`),
              ];
              return (
                <li key={skill.id} className="py-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-ink">{skill.name}</span>
                        {!skill.enabled && <Badge tone="neutral">off</Badge>}
                        <Badge tone="neutral">{skill.instructionChars.toLocaleString("en-US")} characters</Badge>
                        {skill.files.length > 0 && (
                          <Badge tone="neutral">
                            {skill.files.length} file{skill.files.length === 1 ? "" : "s"}
                          </Badge>
                        )}
                        {usedBy.length > 0 ? (
                          <span title={usedBy.join(", ")}>
                            <Badge tone="signal">
                              <Icon name="agents" size={12} /> used by {usedBy.length}
                            </Badge>
                          </span>
                        ) : (
                          <Badge tone="warn">not given to anyone</Badge>
                        )}
                      </div>
                      {skill.description && <p className="mt-1 text-sm text-ink-2">{skill.description}</p>}
                      {usedBy.length > 0 && <p className="mt-1 text-xs text-ink-3">{usedBy.join(", ")}</p>}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {isAdmin && (
                        <Toggle
                          checked={skill.enabled}
                          disabled={busy[skill.id]}
                          onChange={(v) => void setEnabled(skill, v)}
                          label={`${skill.name}: on or off`}
                        />
                      )}
                      <Button variant="ghost" onClick={() => void show(skill)} aria-expanded={openId === skill.id}>
                        {openId === skill.id ? "Hide" : "Read"}
                      </Button>
                      {isAdmin && (
                        <Button variant="danger" loading={busy[skill.id]} onClick={() => void remove(skill)} aria-label={`Delete ${skill.name}`}>
                          <Icon name="trash" />
                        </Button>
                      )}
                    </div>
                  </div>
                  {openId === skill.id && <SkillDetail skill={skill} isAdmin={isAdmin} onEdit={() => void edit(skill)} />}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
