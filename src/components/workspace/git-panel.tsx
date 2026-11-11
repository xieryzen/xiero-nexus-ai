"use client";

import { useState } from "react";
import { apiFetch, ApiError } from "@/lib/client";
import { formatRelative } from "@/lib/format";
import { Alert, Badge, Button, Card, Field, Input } from "@/components/ui";
import { Icon } from "@/components/icons";

interface RemoteDTO {
  host: string;
  owner: string;
  repo: string;
  branch: string;
  tokenLast4: string | null;
  lastPushAt: string | Date | null;
  lastPushSha: string | null;
}

export function GitPanel({ projectId, initial }: { projectId: string; initial: RemoteDTO | null }) {
  const [remote, setRemote] = useState<RemoteDTO | null>(initial);
  const [editing, setEditing] = useState(!initial);
  const [host, setHost] = useState(initial?.host ?? "api.github.com");
  const [owner, setOwner] = useState(initial?.owner ?? "");
  const [repo, setRepo] = useState(initial?.repo ?? "");
  const [branch, setBranch] = useState(initial?.branch ?? "main");
  const [token, setToken] = useState("");
  const [message, setMessage] = useState("Update from Xiero Nexus AI");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pushing, setPushing] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const res = await apiFetch<{ remote: RemoteDTO }>(`/api/projects/${projectId}/git`, {
        method: "PUT",
        body: JSON.stringify({ host, owner, repo, branch, token }),
      });
      setRemote(res.remote);
      setToken("");
      setEditing(false);
      setNote("Remote saved.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save remote");
    } finally {
      setSaving(false);
    }
  }

  async function push() {
    setError(null);
    setNote(null);
    setPushing(true);
    try {
      const res = await apiFetch<{ commitSha: string; fileCount: number; branch: string }>(
        `/api/projects/${projectId}/git/push`,
        { method: "POST", body: JSON.stringify({ message }) },
      );
      setNote(`Pushed ${res.fileCount} files to ${res.branch} · ${res.commitSha.slice(0, 7)}`);
      setRemote((r) => (r ? { ...r, lastPushSha: res.commitSha, lastPushAt: new Date() } : r));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Push failed");
    } finally {
      setPushing(false);
    }
  }

  async function remove() {
    if (!confirm("Remove the Git remote configuration?")) return;
    try {
      await apiFetch(`/api/projects/${projectId}/git`, { method: "DELETE" });
      setRemote(null);
      setEditing(true);
      setOwner("");
      setRepo("");
    } catch {
      /* ignore */
    }
  }

  return (
    <Card
      title="Git remote"
      description="Push the workspace to a GitHub repository as one commit, via the GitHub API (no shell, token encrypted)."
      actions={<Icon name="git" />}
    >
      {error && <div className="mb-3"><Alert tone="danger">{error}</Alert></div>}
      {note && <div className="mb-3"><Alert tone="ok">{note}</Alert></div>}

      {!editing && remote ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="mono text-ink">{remote.owner}/{remote.repo}</span>
            <Badge tone="neutral">{remote.branch}</Badge>
            {remote.host !== "api.github.com" && <Badge tone="neutral">{remote.host}</Badge>}
            <span className="text-xs text-ink-3">token •••• {remote.tokenLast4}</span>
          </div>
          {remote.lastPushSha && (
            <p className="text-xs text-ink-3">
              Last push {remote.lastPushAt ? formatRelative(remote.lastPushAt) : ""} · <span className="mono">{remote.lastPushSha.slice(0, 7)}</span>
            </p>
          )}
          <div className="flex items-center gap-2">
            <Input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Commit message" />
            <Button onClick={push} loading={pushing}><Icon name="git" /> Push</Button>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setEditing(true)}>Edit remote</Button>
            <Button variant="danger" onClick={remove}>Remove</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={save} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Owner" htmlFor="g-owner"><Input id="g-owner" value={owner} onChange={(e) => setOwner(e.target.value)} required placeholder="your-org" /></Field>
            <Field label="Repo" htmlFor="g-repo"><Input id="g-repo" value={repo} onChange={(e) => setRepo(e.target.value)} required placeholder="my-repo" /></Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Branch" htmlFor="g-branch" hint="Must already exist."><Input id="g-branch" value={branch} onChange={(e) => setBranch(e.target.value)} /></Field>
            <Field label="API host" htmlFor="g-host" hint="api.github.com, or your GH Enterprise /api/v3 host."><Input id="g-host" value={host} onChange={(e) => setHost(e.target.value)} className="mono" /></Field>
          </div>
          <Field label="Access token (PAT)" htmlFor="g-token" hint="Needs repo contents write. Stored encrypted; never shown again.">
            <Input id="g-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} required placeholder="ghp_…" className="mono" />
          </Field>
          <div className="flex justify-end gap-2">
            {remote && <Button type="button" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>}
            <Button type="submit" loading={saving}>Save remote</Button>
          </div>
        </form>
      )}
    </Card>
  );
}
