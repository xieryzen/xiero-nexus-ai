"use client";

import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/client";
import { formatRelative } from "@/lib/format";
import { Alert, Badge, Button, Card, EmptyState, Input, Spinner, Textarea, cn } from "@/components/ui";
import { Icon } from "@/components/icons";

interface FileMeta {
  id: string;
  path: string;
  size: number;
  updatedAt: string | Date;
}
interface ExecRun {
  id: string;
  command: string;
  status: string;
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
  durationMs: number | null;
  createdAt: string | Date;
}
interface SnapshotMeta {
  id: string;
  message: string;
  fileCount: number;
  createdAt: string | Date;
}

export function WorkspaceClient({
  workspaceId,
  initialFiles,
  execution,
}: {
  workspaceId: string;
  initialFiles: FileMeta[];
  execution: { enabled: boolean; allowedCommands: string[] };
}) {
  const [files, setFiles] = useState<FileMeta[]>(initialFiles);
  const [openId, setOpenId] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const [command, setCommand] = useState("npm test");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; exitCode: number | null; stdout: string; stderr: string; durationMs: number } | null>(null);
  const [execError, setExecError] = useState<string | null>(null);
  const [runs, setRuns] = useState<ExecRun[]>([]);

  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [snapMsg, setSnapMsg] = useState("");
  const [snapBusy, setSnapBusy] = useState(false);

  useEffect(() => {
    apiFetch<{ runs: ExecRun[] }>(`/api/workspaces/${workspaceId}/exec-runs`).then((r) => setRuns(r.runs)).catch(() => {});
    apiFetch<{ snapshots: SnapshotMeta[] }>(`/api/workspaces/${workspaceId}/snapshots`).then((r) => setSnapshots(r.snapshots)).catch(() => {});
  }, [workspaceId]);

  async function reloadFiles() {
    try {
      const r = await apiFetch<{ files: FileMeta[] }>(`/api/workspaces/${workspaceId}/files`);
      setFiles(r.files);
      setOpenId(null);
      setContent("");
    } catch {
      /* ignore */
    }
  }

  async function commit() {
    setSnapBusy(true);
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/snapshots`, { method: "POST", body: JSON.stringify({ message: snapMsg }) });
      setSnapMsg("");
      const r = await apiFetch<{ snapshots: SnapshotMeta[] }>(`/api/workspaces/${workspaceId}/snapshots`);
      setSnapshots(r.snapshots);
    } catch {
      /* ignore */
    } finally {
      setSnapBusy(false);
    }
  }

  async function restore(id: string) {
    if (!confirm("Restore this snapshot? Current files will be replaced.")) return;
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/snapshots/${id}`, { method: "POST" });
      await reloadFiles();
    } catch {
      /* ignore */
    }
  }

  async function open(id: string) {
    setOpenId(id);
    setDirty(false);
    setFileError(null);
    try {
      const r = await apiFetch<{ file: { content: string } }>(`/api/workspaces/${workspaceId}/files/${id}`);
      setContent(r.file.content);
    } catch {
      setContent("");
    }
  }

  async function newFile() {
    const path = prompt("New file path (e.g. src/index.ts)");
    if (!path) return;
    setFileError(null);
    try {
      const r = await apiFetch<{ file: FileMeta }>(`/api/workspaces/${workspaceId}/files`, {
        method: "POST",
        body: JSON.stringify({ path, content: "" }),
      });
      setFiles((f) => [...f.filter((x) => x.path !== r.file.path), r.file].sort((a, b) => a.path.localeCompare(b.path)));
      open(r.file.id);
    } catch (err) {
      setFileError(err instanceof ApiError ? err.message : "Could not create file");
    }
  }

  async function save() {
    if (!openId) return;
    setFileBusy(true);
    setFileError(null);
    try {
      const r = await apiFetch<{ file: FileMeta }>(`/api/workspaces/${workspaceId}/files/${openId}`, {
        method: "PATCH",
        body: JSON.stringify({ content }),
      });
      setFiles((f) => f.map((x) => (x.id === openId ? r.file : x)));
      setDirty(false);
    } catch (err) {
      setFileError(err instanceof ApiError ? err.message : "Could not save");
    } finally {
      setFileBusy(false);
    }
  }

  async function del() {
    if (!openId) return;
    const f = files.find((x) => x.id === openId);
    if (!f || !confirm(`Delete ${f.path}?`)) return;
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/files/${openId}`, { method: "DELETE" });
      setFiles((list) => list.filter((x) => x.id !== openId));
      setOpenId(null);
      setContent("");
    } catch {
      /* ignore */
    }
  }

  async function run() {
    setRunning(true);
    setExecError(null);
    setResult(null);
    try {
      const r = await apiFetch<{ ok: boolean; exitCode: number | null; stdout: string; stderr: string; durationMs: number }>(
        `/api/workspaces/${workspaceId}/exec`,
        { method: "POST", body: JSON.stringify({ command }) },
      );
      setResult(r);
    } catch (err) {
      setExecError(err instanceof ApiError ? err.message : "Execution failed");
    } finally {
      setRunning(false);
      apiFetch<{ runs: ExecRun[] }>(`/api/workspaces/${workspaceId}/exec-runs`).then((r) => setRuns(r.runs)).catch(() => {});
    }
  }

  return (
    <div className="space-y-6">
      {/* Files */}
      <Card
        title="Files"
        description="Artifacts written by agents land here. You can edit them before running."
        actions={<Button variant="ghost" onClick={newFile}><Icon name="plus" /> New file</Button>}
      >
        {fileError && <div className="mb-3"><Alert tone="danger">{fileError}</Alert></div>}
        <div className="grid gap-4 md:grid-cols-[220px_1fr]">
          <div className="rounded-md border border-line">
            {files.length === 0 ? (
              <p className="p-3 text-xs text-ink-3">No files yet.</p>
            ) : (
              <ul className="max-h-80 overflow-y-auto py-1">
                {files.map((f) => (
                  <li key={f.id}>
                    <button
                      onClick={() => open(f.id)}
                      className={cn(
                        "mono block w-full truncate px-3 py-1.5 text-left text-xs transition",
                        openId === f.id ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface-2/60",
                      )}
                    >
                      {f.path}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            {openId ? (
              <div className="space-y-2">
                <Textarea
                  value={content}
                  onChange={(e) => { setContent(e.target.value); setDirty(true); }}
                  className="mono min-h-[260px] text-xs leading-relaxed"
                  spellCheck={false}
                />
                <div className="flex items-center gap-2">
                  <Button onClick={save} loading={fileBusy} disabled={!dirty}>Save</Button>
                  <Button variant="danger" onClick={del}><Icon name="trash" /> Delete</Button>
                  {dirty && <span className="text-xs text-warn">unsaved changes</span>}
                </div>
              </div>
            ) : (
              <div className="grid h-full min-h-[200px] place-items-center rounded-md border border-dashed border-line text-sm text-ink-3">
                Select a file to view or edit
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* Execute */}
      <Card title="Execute" description="Run a build or test command in an isolated sandbox.">
        {!execution.enabled ? (
          <Alert tone="warn">
            Execution is disabled. Code never runs on the app host — configure an isolated runner
            (<span className="mono">SANDBOX_URL</span>) to enable it. See <span className="mono">sandbox-runner/README.md</span>.
          </Alert>
        ) : (
          <>
            <p className="mb-2 text-xs text-ink-3">
              Allowed: <span className="mono">{execution.allowedCommands.slice(0, 12).join(" ")}</span>
              {execution.allowedCommands.length > 12 ? " …" : ""}
            </p>
            <div className="flex gap-2">
              <Input value={command} onChange={(e) => setCommand(e.target.value)} className="mono" placeholder="npm test" />
              <Button onClick={run} loading={running} disabled={!command.trim()}>
                <Icon name="test" /> Run
              </Button>
            </div>
            {execError && <div className="mt-3"><Alert tone="danger">{execError}</Alert></div>}
            {running && <div className="mt-3 flex items-center gap-2 text-sm text-ink-2"><Spinner /> running in sandbox…</div>}
            {result && (
              <div className="mt-3 space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <Badge tone={result.ok ? "ok" : "danger"}>exit {result.exitCode ?? "—"}</Badge>
                  <span className="text-xs text-ink-3">{result.durationMs} ms</span>
                </div>
                {result.stdout && <OutputBlock label="stdout" text={result.stdout} />}
                {result.stderr && <OutputBlock label="stderr" text={result.stderr} tone="danger" />}
              </div>
            )}
          </>
        )}

        {runs.length > 0 && (
          <div className="mt-5">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-3">Recent runs</h3>
            <ul className="divide-y divide-line">
              {runs.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="mono truncate text-ink-2">{r.command}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <Badge tone={r.status === "ok" ? "ok" : "danger"}>{r.exitCode ?? r.status}</Badge>
                    <span className="text-xs text-ink-3">{formatRelative(r.createdAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {/* Snapshots */}
      <Card title="Snapshots" description="Lightweight local version history. Commit the current files, and restore any snapshot.">
        <div className="flex gap-2">
          <Input value={snapMsg} onChange={(e) => setSnapMsg(e.target.value)} placeholder="Snapshot message (optional)" />
          <Button onClick={commit} loading={snapBusy}>
            <Icon name="copy" /> Commit
          </Button>
        </div>
        {snapshots.length === 0 ? (
          <p className="mt-3 text-sm text-ink-3">No snapshots yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {snapshots.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div className="min-w-0">
                  <span className="truncate text-ink">{s.message || "(no message)"}</span>
                  <span className="ml-2 text-xs text-ink-3">{s.fileCount} files · {formatRelative(s.createdAt)}</span>
                </div>
                <Button variant="ghost" onClick={() => restore(s.id)}>
                  <Icon name="refresh" /> Restore
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function OutputBlock({ label, text, tone }: { label: string; text: string; tone?: "danger" }) {
  return (
    <div>
      <p className={cn("mb-1 text-xs uppercase tracking-wider", tone === "danger" ? "text-danger" : "text-ink-3")}>{label}</p>
      <pre className="max-h-72 overflow-auto rounded-md border border-line bg-surface-2 p-3 text-xs text-ink-2">{text}</pre>
    </div>
  );
}
