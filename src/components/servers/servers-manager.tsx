"use client";

import Link from "next/link";
import { useState } from "react";
import { apiFetch, ApiError } from "@/lib/client";
import type { CommandDTO, ServerDTO } from "@/lib/ssh/servers";
import { KEEPALIVE_INTERVAL_MS, SERVER_NOTES_MAX, took } from "@/lib/ssh/rules";
import { DateTime, RelativeTime } from "@/components/time";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, Textarea, Toggle } from "@/components/ui";
import { Icon } from "@/components/icons";

export interface ServerRow extends ServerDTO {
  /** The runs that hold a connection to it now. */
  open: { projectId: string | null; projectTitle: string | null; since: number | null; commands: number; connected: boolean }[];
}

interface ShownKey {
  hostKey: string;
  type: string;
  fingerprint: string;
  file: string;
}

interface CheckResult {
  ok: boolean;
  output?: string;
  durationMs?: number;
  error?: string;
  kind?: string;
  /** The key the machine showed in place of the one that was accepted. */
  shown?: { hostKey: string; fingerprint: string } | null;
}

const message = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

const ACCESS_LABEL: Record<ServerDTO["access"], string> = {
  owners: "Owners only",
  admins: "Owners and administrators",
};

// ─── Registering and changing ────────────────────────────────────────────────

function ServerForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial?: ServerRow;
  onSaved: (server: ServerDTO, checked: string | null) => void;
  onCancel: () => void;
}) {
  const editing = Boolean(initial);
  const [name, setName] = useState(initial?.name ?? "");
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState(String(initial?.port ?? 22));
  const [username, setUsername] = useState(initial?.username ?? "root");
  const [authType, setAuthType] = useState<"password" | "key">(initial?.authType ?? "password");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [access, setAccess] = useState<ServerDTO["access"]>(initial?.access ?? "owners");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  // The key the machine showed for the host and port that are in the form now.
  const [key, setKey] = useState<ShownKey | null>(null);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const moved = editing && (host.trim() !== initial!.host || Number(port) !== initial!.port);
  // A machine that is registered keeps its key while it stays where it is.
  const needsKey = !editing || moved;
  const newSecret = authType === "password" ? password !== "" : privateKey.trim() !== "";
  const secretNeeded = !editing || authType !== initial!.authType;

  function place(set: (value: string) => void) {
    return (value: string) => {
      set(value);
      setKey(null);
    };
  }

  async function readKey() {
    setError(null);
    setReading(true);
    try {
      setKey(await apiFetch<ShownKey>("/api/servers/host-key", { method: "POST", body: JSON.stringify({ host: host.trim(), port: Number(port) || 22 }) }));
    } catch (err) {
      setKey(null);
      setError(message(err, "The host key could not be read."));
    } finally {
      setReading(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const secret =
        authType === "password"
          ? password !== "" ? { password } : {}
          : privateKey.trim() !== "" ? { privateKey, passphrase: passphrase || null } : passphrase !== "" ? { passphrase } : {};
      const body = editing
        ? {
            ...(name.trim() !== initial!.name ? { name: name.trim() } : {}),
            ...(moved ? { host: host.trim(), port: Number(port) || 22, hostKey: key?.hostKey } : {}),
            ...(username.trim() !== initial!.username ? { username: username.trim() } : {}),
            ...(authType !== initial!.authType ? { authType } : {}),
            ...secret,
            ...(access !== initial!.access ? { access } : {}),
            ...((notes.trim() || null) !== (initial!.notes ?? null) ? { notes: notes.trim() || null } : {}),
          }
        : { name: name.trim(), host: host.trim(), port: Number(port) || 22, username: username.trim(), authType, ...secret, hostKey: key?.hostKey, access, notes: notes.trim() || null };
      if (editing && Object.keys(body).length === 0) {
        onCancel();
        return;
      }
      const res = await apiFetch<{ server: ServerDTO; checked: string | null }>(editing ? `/api/servers/${initial!.id}` : "/api/servers", {
        method: editing ? "PATCH" : "POST",
        body: JSON.stringify(body),
      });
      onSaved(res.server, res.checked);
    } catch (err) {
      setError(message(err, "The server could not be saved."));
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-4" data-testid="server-form">
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="sv-name" hint="How projects and agents name it: lower-case letters, digits, . _ -">
          <Input id="sv-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={40} placeholder="vps-1" autoComplete="off" />
        </Field>
        <Field label="Who may use it" htmlFor="sv-access" hint="Whose projects may work on it. Never a user's.">
          <Select id="sv-access" value={access} onChange={(e) => setAccess(e.target.value as ServerDTO["access"])}>
            <option value="owners">{ACCESS_LABEL.owners}</option>
            <option value="admins">{ACCESS_LABEL.admins}</option>
          </Select>
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-[1fr_7rem_1fr]">
        <Field label="Host" htmlFor="sv-host" hint="A name or an address.">
          <Input id="sv-host" value={host} onChange={(e) => place(setHost)(e.target.value)} required placeholder="203.0.113.10" autoComplete="off" />
        </Field>
        <Field label="Port" htmlFor="sv-port">
          <Input id="sv-port" type="number" min={1} max={65535} value={port} onChange={(e) => place(setPort)(e.target.value)} required />
        </Field>
        <Field label="Username" htmlFor="sv-user" hint="The account commands run as.">
          <Input id="sv-user" value={username} onChange={(e) => setUsername(e.target.value)} required autoComplete="off" />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
        <Field label="Sign in with" htmlFor="sv-auth">
          <Select id="sv-auth" value={authType} onChange={(e) => setAuthType(e.target.value as "password" | "key")}>
            <option value="password">A password</option>
            <option value="key">A private key</option>
          </Select>
        </Field>
        {authType === "password" ? (
          <Field label="Password" htmlFor="sv-password" hint={secretNeeded ? "Kept encrypted, and never shown again." : "Leave empty to keep the one that is registered."}>
            <Input id="sv-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required={secretNeeded} autoComplete="new-password" />
          </Field>
        ) : (
          <div className="space-y-3">
            <Field
              label="Private key"
              htmlFor="sv-key"
              hint={secretNeeded ? 'The file without ".pub", whole: it begins with "-----BEGIN". Kept encrypted, and never shown again.' : "Leave empty to keep the one that is registered."}
            >
              <Textarea id="sv-key" value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} required={secretNeeded} className="mono min-h-[110px] text-xs" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" spellCheck={false} />
            </Field>
            <Field label="Passphrase of the key" htmlFor="sv-passphrase" hint="Only when the key has one.">
              <Input id="sv-passphrase" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="new-password" />
            </Field>
          </div>
        )}
      </div>

      <Field label="Notes for the agents" htmlFor="sv-notes" hint="What an agent should know before it starts: the system it runs, what it is for, what to leave alone.">
        <Input id="sv-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={SERVER_NOTES_MAX} placeholder="Ubuntu 24.04, 4 GB. Runs the panel: do not touch /var/www/pterodactyl." />
      </Field>

      {needsKey && (
        <div className="rounded-md border border-line bg-surface-2/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-ink">The machine&apos;s host key</p>
              <p className="text-xs text-ink-3">
                What the machine shows to prove that it is itself. It is read without signing in; nothing of the password or the key is sent before you have accepted it.
              </p>
            </div>
            <Button type="button" variant="ghost" onClick={readKey} loading={reading} disabled={!host.trim()}>
              <Icon name="shield" size={16} /> {key ? "Read it again" : "Read host key"}
            </Button>
          </div>
          {key && (
            <div className="mt-3 space-y-1.5" data-testid="host-key">
              <p className="mono break-all text-xs text-ink">
                {key.type} <span className="text-accent-ink">{key.fingerprint}</span>
              </p>
              <p className="text-xs text-ink-3">
                Compare it on the machine itself: <code className="mono">ssh-keygen -lf {key.file}</code> prints the same line when it is the right machine. Registering accepts this key: from then on the app signs in only to a machine that shows it.
              </p>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <p className="mr-auto text-xs text-ink-3">
          {editing && !moved && !newSecret && authType === initial!.authType && username.trim() === initial!.username
            ? "Nothing about the connection changes: it is saved without signing in."
            : "The app signs in once and runs one harmless command. Only when that works is anything saved."}
        </p>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" loading={saving} disabled={needsKey && !key}>
          {editing ? "Save server" : "Register server"}
        </Button>
      </div>
    </form>
  );
}

// ─── The log ─────────────────────────────────────────────────────────────────

const STATUS_TONE: Record<CommandDTO["status"], "ok" | "warn" | "danger" | "neutral"> = {
  ok: "ok",
  failed: "warn",
  timeout: "warn",
  cancelled: "neutral",
  lost: "danger",
  refused: "danger",
};

function statusLabel(c: CommandDTO): string {
  if (c.kind === "session") return c.status === "ok" ? "connection" : c.status === "lost" ? "lost" : "not connected";
  if (c.kind === "test") return c.status === "ok" ? "check passed" : "check failed";
  switch (c.status) {
    case "ok":
      return "exit 0";
    case "failed":
      return c.signal ? `signal ${c.signal}` : `exit ${c.exitCode ?? "?"}`;
    case "timeout":
      return "time was up";
    case "cancelled":
      return "run stopped";
    case "lost":
      return "connection lost";
    case "refused":
      return "not started";
  }
}

function LogRow({ entry }: { entry: CommandDTO }) {
  const [open, setOpen] = useState(false);
  const command = entry.kind === "command";
  return (
    <li className="px-5 py-3" data-log-kind={entry.kind} data-log-status={entry.status}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
        <DateTime at={entry.createdAt} />
        <span className="font-medium text-ink-2">{entry.serverName}</span>
        <Badge tone={STATUS_TONE[entry.status]}>{statusLabel(entry)}</Badge>
        {entry.durationMs !== null && <span>{took(entry.durationMs)}</span>}
        {entry.projectTitle &&
          (entry.projectId ? (
            <Link href={`/dashboard/projects/${entry.projectId}`} className="text-accent-ink hover:underline">{entry.projectTitle}</Link>
          ) : (
            <span>{entry.projectTitle}</span>
          ))}
        {entry.taskTitle && <span>{entry.taskTitle}</span>}
        {entry.agentName && <span>by {entry.agentName}</span>}
        {entry.username && <span>for {entry.username}</span>}
      </div>
      <div className="mt-1.5 flex items-start gap-2">
        <p className={command ? "mono min-w-0 flex-1 whitespace-pre-wrap break-all text-xs text-ink" : "min-w-0 flex-1 text-sm text-ink-2"}>
          {command && !open && entry.command.length > 240 ? `${entry.command.slice(0, 240)}…` : entry.command}
          {!command && entry.output ? <span className="text-ink-3"> · {entry.output}</span> : null}
        </p>
        {command && (entry.output || entry.command.length > 240) && (
          <button type="button" onClick={() => setOpen((v) => !v)} className="shrink-0 text-xs font-medium text-accent-ink hover:underline">
            {open ? "Hide" : "Output"}
          </button>
        )}
      </div>
      {command && open && (
        <pre className="mono mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-surface-2 p-3 text-[11px] leading-relaxed text-ink-2">
          {entry.output || "(it printed nothing)"}
        </pre>
      )}
    </li>
  );
}

// ─── The page ────────────────────────────────────────────────────────────────

export function ServersManager({
  initialServers,
  initialLog,
  canManage,
  keepaliveSeconds = Math.round(KEEPALIVE_INTERVAL_MS / 1000),
}: {
  initialServers: ServerRow[];
  initialLog: CommandDTO[];
  /** An owner: registers, changes, checks and removes. Anyone else reads. */
  canManage: boolean;
  /** How often an open connection says that it is still there, as this server is set. */
  keepaliveSeconds?: number;
}) {
  const [list, setList] = useState(initialServers);
  const [form, setForm] = useState<{ mode: "new" } | { mode: "edit"; server: ServerRow } | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [checks, setChecks] = useState<Record<string, CheckResult>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState(initialLog);
  const [filter, setFilter] = useState("");
  const [more, setMore] = useState(initialLog.length >= 30);
  const [loadingLog, setLoadingLog] = useState(false);

  async function loadLog(server: string, before?: number) {
    setLoadingLog(true);
    try {
      const query = new URLSearchParams({ limit: "30" });
      if (server) query.set("server", server);
      if (before) query.set("before", String(before));
      const res = await apiFetch<{ commands: CommandDTO[] }>(`/api/servers/commands?${query}`);
      // The page before starts at the moment of the last row shown: what is here already is left out.
      setLog((current) => (before ? [...current, ...res.commands.filter((c) => !current.some((have) => have.id === c.id))] : res.commands));
      setMore(res.commands.length >= 30);
    } catch (err) {
      setError(message(err, "The log could not be read."));
    } finally {
      setLoadingLog(false);
    }
  }

  async function reload() {
    try {
      const res = await apiFetch<{ servers: ServerRow[] }>("/api/servers");
      setList(res.servers);
    } catch {
      // The list stays as it is; the next action says what is wrong.
    }
    await loadLog(filter);
  }

  const working = (id: string, on: boolean) => setBusy((b) => ({ ...b, [id]: on }));

  async function check(server: ServerRow) {
    working(server.id, true);
    setError(null);
    try {
      const res = await apiFetch<CheckResult & { server: ServerDTO }>(`/api/servers/${server.id}/test`, { method: "POST", body: "{}" });
      setChecks((c) => ({ ...c, [server.id]: res }));
      setList((l) => l.map((s) => (s.id === server.id ? { ...s, ...res.server } : s)));
      void loadLog(filter);
    } catch (err) {
      setError(message(err, "The check could not be made."));
    } finally {
      working(server.id, false);
    }
  }

  async function change(server: ServerRow, body: Record<string, unknown>, done: string) {
    working(server.id, true);
    setError(null);
    try {
      const res = await apiFetch<{ server: ServerDTO }>(`/api/servers/${server.id}`, { method: "PATCH", body: JSON.stringify(body) });
      setList((l) => l.map((s) => (s.id === server.id ? { ...s, ...res.server } : s)));
      setChecks((c) => {
        const { [server.id]: _gone, ...rest } = c;
        return rest;
      });
      setNotice(done);
      void loadLog(filter);
    } catch (err) {
      setError(message(err, "That could not be changed."));
    } finally {
      working(server.id, false);
    }
  }

  async function remove(server: ServerRow) {
    const used = server.projects > 0 ? ` ${server.projects} project${server.projects === 1 ? " names" : "s name"} it and will be without it.` : "";
    if (!confirm(`Remove the server "${server.name}"?${used} What was done on it stays in the log.`)) return;
    working(server.id, true);
    setError(null);
    try {
      await apiFetch(`/api/servers/${server.id}`, { method: "DELETE" });
      setList((l) => l.filter((s) => s.id !== server.id));
      setNotice(`"${server.name}" was removed.`);
      void loadLog(filter);
    } catch (err) {
      setError(message(err, "The server could not be removed."));
      working(server.id, false);
    }
  }

  function saved(server: ServerDTO, checked: string | null) {
    setList((l) => {
      const row: ServerRow = { ...server, open: l.find((s) => s.id === server.id)?.open ?? [] };
      return l.some((s) => s.id === server.id) ? l.map((s) => (s.id === server.id ? row : s)) : [...l, row].sort((a, b) => a.name.localeCompare(b.name));
    });
    setNotice(
      checked !== null
        ? `"${server.name}" is ${form?.mode === "edit" ? "saved" : "registered"}: the app signed in and ran one command${checked ? ` (${checked.replace(/\s+/g, " ")})` : ""}.`
        : `"${server.name}" is saved.`,
    );
    setForm(null);
    void loadLog(filter);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Servers"
        description="The machines your agents may work on over SSH. Only what is registered here can be reached, and every command is written down."
        actions={
          <>
            <Button variant="ghost" onClick={() => void reload()}><Icon name="refresh" size={16} /> Refresh</Button>
            {canManage && !form && <Button onClick={() => { setForm({ mode: "new" }); setNotice(null); }}><Icon name="plus" /> New server</Button>}
          </>
        }
      />

      {notice && <Alert tone="ok">{notice}</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}

      {form && (
        <Card title={form.mode === "new" ? "New server" : `Change ${form.server.name}`}>
          <ServerForm key={form.mode === "edit" ? form.server.id : "new"} initial={form.mode === "edit" ? form.server : undefined} onSaved={saved} onCancel={() => setForm(null)} />
        </Card>
      )}

      {list.length === 0 ? (
        <EmptyState
          title={canManage ? "No server is registered yet" : "No server is open to administrators"}
          description={canManage ? "Register the machine your agents should work on. The app signs in once to see that it works." : "An owner registers the servers and says whose projects may work on them."}
          action={canManage && !form ? <Button onClick={() => setForm({ mode: "new" })}><Icon name="plus" /> New server</Button> : undefined}
        />
      ) : (
        <div className="space-y-3">
          {list.map((s) => {
            const result = checks[s.id];
            return (
              <Card key={s.id}>
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between" data-server={s.name}>
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Icon name="server" className="text-ink-3" />
                      <span className="font-medium text-ink">{s.name}</span>
                      <Badge tone={s.status === "enabled" ? "ok" : "neutral"}>{s.status === "enabled" ? "on" : "switched off"}</Badge>
                      <Badge tone="neutral">{ACCESS_LABEL[s.access]}</Badge>
                      {s.open.map((o, i) => (
                        <Badge key={i} tone="signal">
                          {o.connected ? "connected now" : "reconnecting"}{o.projectTitle ? `: ${o.projectTitle}` : ""}
                        </Badge>
                      ))}
                    </div>
                    <p className="mono break-all text-xs text-ink-2">
                      {s.username}@{s.host}:{s.port} · signs in with a {s.authType === "password" ? "password" : "key"}
                    </p>
                    <p className="mono break-all text-xs text-ink-3">
                      host key {s.hostKeyType} {s.fingerprint}
                    </p>
                    {s.notes && <p className="text-sm text-ink-2">{s.notes}</p>}
                    <p className="text-xs text-ink-3">
                      {s.lastConnectedAt ? <>Last connected <RelativeTime at={s.lastConnectedAt} /></> : "Never connected"}
                      {" · "}
                      {s.projects === 0 ? "no project names it" : `${s.projects} project${s.projects === 1 ? " names" : "s name"} it`}
                    </p>
                    {s.lastError && !result && <p className="text-xs text-danger">Last problem: {s.lastError}</p>}
                  </div>
                  {canManage && (
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <Toggle
                        checked={s.status === "enabled"}
                        onChange={(on) => void change(s, { status: on ? "enabled" : "disabled" }, on ? `"${s.name}" is switched on.` : `"${s.name}" is switched off: no project works on it until it is on again.`)}
                        disabled={busy[s.id]}
                        label={`Server ${s.name} is on`}
                      />
                      <Button variant="ghost" loading={busy[s.id]} onClick={() => void check(s)}><Icon name="test" size={16} /> Check</Button>
                      <Button variant="ghost" onClick={() => { setForm({ mode: "edit", server: s }); setNotice(null); }}>Change</Button>
                      <Button variant="danger" loading={busy[s.id]} onClick={() => void remove(s)} aria-label={`Remove ${s.name}`}><Icon name="trash" /></Button>
                    </div>
                  )}
                </div>
                {result && (
                  <div className="mt-4" data-testid="check-result">
                    {result.ok ? (
                      <Alert tone="ok">
                        The app signed in and ran one command{result.durationMs !== undefined ? ` in ${took(result.durationMs)}` : ""}
                        {result.output ? <>: <span className="mono">{result.output.replace(/\s+/g, " ")}</span></> : "."}
                      </Alert>
                    ) : (
                      <Alert tone="danger">
                        <p>{result.error}</p>
                        {result.shown && canManage && (
                          <div className="mt-2 space-y-2">
                            <p className="mono break-all text-xs">It showed: {result.shown.fingerprint}</p>
                            <p className="text-xs">
                              Compare that on the machine (<code className="mono">ssh-keygen -lf {s.hostKeyFile}</code>). Accept it only when the machine was set up again and the line is the same.
                            </p>
                            <Button variant="ghost" loading={busy[s.id]} onClick={() => void change(s, { hostKey: result.shown!.hostKey }, `The new host key of "${s.name}" is accepted: the app signed in to the machine that shows it.`)}>
                              Accept this key
                            </Button>
                          </div>
                        )}
                      </Alert>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      <Card title="How agents work on a server">
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-ink-2">
          <li>
            A project names the servers it works on, and an agent that has the tool <span className="text-ink">Work on servers</span> (Agents page) runs commands there. Without both, nothing is reached.
          </li>
          <li>
            A run opens <span className="text-ink">one connection</span> to a server with its first command and keeps it open, saying every {keepaliveSeconds === 1 ? "second" : `${keepaliveSeconds} seconds`} that it is still there, <span className="text-ink">until the run has ended</span>: through every task, and through the minutes in which nothing is sent. Then it is closed. If the connection is lost on the way, the next command opens it again.
          </li>
          <li>Every command is written down below with how it ended, who it was for, and which agent ran it. The connections are in the log too: when one was opened, lost and closed.</li>
          <li>
            An agent can run <span className="text-ink">any command the registered account can</span>. Register an account that has the rights the work needs, and no more. Only the projects of owners work on a server, and those of administrators where you say so; never a user&apos;s.
          </li>
        </ul>
      </Card>

      <section className="card" data-testid="server-log">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink">What was done on the servers</h2>
            <p className="mt-0.5 text-xs text-ink-2">Every command, newest first, and every connection that was opened, lost or closed.</p>
          </div>
          <Select
            aria-label="Show the log of"
            value={filter}
            onChange={(e) => { setFilter(e.target.value); void loadLog(e.target.value); }}
            className="w-auto"
          >
            <option value="">All servers</option>
            {list.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
            {canManage && <option value="removed">Servers that were removed</option>}
            {canManage && <option value="handed">Servers handed over in conversations</option>}
          </Select>
        </header>
        {log.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-ink-3">Nothing was done yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {log.map((entry) => (
              <LogRow key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
        {more && (
          <div className="border-t border-line px-5 py-3 text-center">
            <Button variant="ghost" loading={loadingLog} onClick={() => void loadLog(filter, log[log.length - 1]?.createdAt)}>Older</Button>
          </div>
        )}
      </section>
    </div>
  );
}
