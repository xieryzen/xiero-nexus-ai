"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/client";
import type { ActionDTO, SiteAccountDTO } from "@/lib/browser/accounts";
import { took } from "@/lib/browser/rules";
import type { BrowserStatus } from "@/lib/browser/service";
import type { LiveDTO } from "@/lib/browser/sessions";
import { DateTime, RelativeTime } from "@/components/time";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, Textarea, Toggle } from "@/components/ui";
import { Icon } from "@/components/icons";

interface Use {
  runs: number;
  pages: number;
  waiting: number;
}

const message = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

const ACCESS_LABEL: Record<SiteAccountDTO["access"], string> = {
  owners: "Owners only",
  admins: "Owners and administrators",
};

const NOTES_MAX = 500;

// ─── Saving and changing an account ──────────────────────────────────────────

function AccountForm({ initial, onSaved, onCancel }: { initial?: SiteAccountDTO; onSaved: (account: SiteAccountDTO, sessionDropped: boolean) => void; onCancel: () => void }) {
  const editing = Boolean(initial);
  const [name, setName] = useState(initial?.name ?? "");
  const [siteUrl, setSiteUrl] = useState(initial?.siteUrl ?? "https://");
  const [username, setUsername] = useState(initial?.username ?? "");
  const [password, setPassword] = useState("");
  const [access, setAccess] = useState<SiteAccountDTO["access"]>(initial?.access ?? "owners");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body = {
        name: name.trim(),
        siteUrl: siteUrl.trim(),
        username: username.trim(),
        ...(password ? { password } : {}),
        access,
        notes: notes.trim() || null,
      };
      const res = editing
        ? await apiFetch<{ account: SiteAccountDTO; sessionDropped?: boolean }>(`/api/browser/accounts/${initial!.id}`, { method: "PATCH", body: JSON.stringify(body) })
        : await apiFetch<{ account: SiteAccountDTO; sessionDropped?: boolean }>("/api/browser/accounts", { method: "POST", body: JSON.stringify(body) });
      onSaved(res.account, Boolean(res.sessionDropped));
    } catch (err) {
      setError(message(err, "The account could not be saved."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-4" data-testid="account-form">
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="ba-name" hint="How projects and agents call it: lower-case letters, digits and dashes.">
          <Input id="ba-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="shop-admin" maxLength={40} required />
        </Field>
        <Field label="Address of the page where you sign in" htmlFor="ba-url" hint="The site is everything under that name: example.com and what comes before it.">
          <Input id="ba-url" value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} placeholder="https://example.com/login" inputMode="url" required />
        </Field>
        <Field label="User name or e-mail" htmlFor="ba-user">
          <Input id="ba-user" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" maxLength={200} required />
        </Field>
        <Field label="Password" htmlFor="ba-password" hint={editing ? "Leave it empty to keep the one that is saved." : "Kept encrypted. It is typed into the site by the app; no agent is shown it, and neither are you again."}>
          <Input id="ba-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" maxLength={500} required={!editing} />
        </Field>
        <Field label="Whose projects may sign in with it" htmlFor="ba-access">
          <Select id="ba-access" value={access} onChange={(e) => setAccess(e.target.value as SiteAccountDTO["access"])}>
            <option value="owners">Owners only</option>
            <option value="admins">Owners and administrators</option>
          </Select>
        </Field>
      </div>
      <Field label="Notes for the agents" htmlFor="ba-notes" hint="What the account is for, and what to leave alone. Agents are told this.">
        <Textarea id="ba-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={NOTES_MAX} placeholder="The shop's back office. Change prices only; delete nothing." />
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button type="submit" loading={saving}>{editing ? "Save account" : "Save account"}</Button>
      </div>
    </form>
  );
}

// ─── The log ─────────────────────────────────────────────────────────────────

const KIND_LABEL: Record<string, string> = {
  open: "opened",
  click: "clicked",
  type: "typed",
  select: "chose",
  press: "pressed",
  back: "went back",
  sign_in: "signed in",
  person: "a person",
  session: "by hand",
};

function statusTone(status: ActionDTO["status"]): "ok" | "danger" | "warn" | "neutral" {
  if (status === "ok" || status === "waited") return "ok";
  if (status === "failed" || status === "refused") return "danger";
  if (status === "timeout") return "warn";
  return "neutral";
}

function statusLabel(entry: ActionDTO): string {
  if (entry.kind === "person") {
    return entry.status === "waited" ? "handed back" : entry.status === "timeout" ? "nobody came" : entry.status === "cancelled" ? "run stopped" : "given up";
  }
  if (entry.kind === "session") return entry.status === "ok" ? "session kept" : entry.status === "timeout" ? "left open" : entry.status === "failed" ? "nothing to keep" : "not kept";
  if (entry.status === "ok") return "done";
  return entry.status === "refused" ? "not taken" : entry.status;
}

function LogRow({ entry }: { entry: ActionDTO }) {
  return (
    <li className="px-5 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
        <DateTime at={entry.createdAt} />
        <Badge tone="neutral">{KIND_LABEL[entry.kind] ?? entry.kind}</Badge>
        <Badge tone={statusTone(entry.status)}>{statusLabel(entry)}</Badge>
        {entry.durationMs !== null && entry.durationMs >= 1000 && <span>{took(entry.durationMs)}</span>}
        {entry.accountName && <span className="mono text-ink-2">{entry.accountName}</span>}
        {entry.projectTitle &&
          (entry.projectId ? (
            <Link href={`/dashboard/projects/${entry.projectId}`} className="text-signal hover:underline">{entry.projectTitle}</Link>
          ) : (
            <span>{entry.projectTitle}</span>
          ))}
        {entry.taskTitle && <span>{entry.taskTitle}</span>}
        {entry.agentName && <span>by {entry.agentName}</span>}
        {entry.username && <span>for {entry.username}</span>}
      </div>
      {entry.detail && <p className="mt-1 break-words text-ink">{entry.detail}</p>}
      {entry.url && <p className="mono mt-0.5 break-all text-xs text-ink-3">{entry.url}</p>}
      {entry.note && <p className="mt-0.5 text-xs text-ink-2">{entry.note}</p>}
    </li>
  );
}

// ─── The page ────────────────────────────────────────────────────────────────

export function BrowserManager({
  initialStatus,
  initialUse,
  initialWaiting,
  initialAccounts,
  initialLog,
  canManage,
  waitMinutes,
  maxPages,
}: {
  initialStatus: BrowserStatus;
  initialUse: Use;
  initialWaiting: LiveDTO[];
  initialAccounts: SiteAccountDTO[];
  initialLog: ActionDTO[];
  /** An owner: saves, changes and removes accounts, and signs in by hand. Anyone else reads. */
  canManage: boolean;
  /** Minutes a page waits for a person. */
  waitMinutes: number;
  /** Pages the browser may have open at once. */
  maxPages: number;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [use, setUse] = useState(initialUse);
  const [waiting, setWaiting] = useState(initialWaiting);
  const [list, setList] = useState(initialAccounts);
  const [form, setForm] = useState<{ mode: "new" } | { mode: "edit"; account: SiteAccountDTO } | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState(initialLog);
  const [more, setMore] = useState(initialLog.length >= 30);
  const [loadingLog, setLoadingLog] = useState(false);
  const [asking, setAsking] = useState(false);

  async function loadService(fresh = false) {
    try {
      const res = await apiFetch<{ status: BrowserStatus; use: Use; waiting: LiveDTO[] }>(`/api/browser${fresh ? "?fresh=1" : ""}`);
      setStatus(res.status);
      setUse(res.use);
      setWaiting(res.waiting);
    } catch {
      // What is shown stays; the next round asks again.
    }
  }

  // A page that waits for a person shows up here by itself.
  useEffect(() => {
    const timer = setInterval(() => void loadService(), 5_000);
    return () => clearInterval(timer);
  }, []);

  // Coming back from another page of the dashboard, the browser may show what
  // this page was given at an earlier visit: the accounts and the log are
  // asked for anew when it is opened.
  useEffect(() => {
    let left = false;
    void (async () => {
      try {
        const [accounts, actions] = await Promise.all([
          apiFetch<{ accounts: SiteAccountDTO[] }>("/api/browser/accounts"),
          apiFetch<{ actions: ActionDTO[] }>("/api/browser/actions?limit=30"),
        ]);
        if (left) return;
        setList(accounts.accounts);
        setLog(actions.actions);
        setMore(actions.actions.length >= 30);
      } catch {
        // What the page was given stays.
      }
    })();
    return () => {
      left = true;
    };
  }, []);

  async function loadLog(before?: number) {
    setLoadingLog(true);
    try {
      const query = new URLSearchParams({ limit: "30" });
      if (before) query.set("before", String(before));
      const res = await apiFetch<{ actions: ActionDTO[] }>(`/api/browser/actions?${query}`);
      setLog((current) => (before ? [...current, ...res.actions.filter((a) => !current.some((have) => have.id === a.id))] : res.actions));
      setMore(res.actions.length >= 30);
    } catch (err) {
      setError(message(err, "The log could not be read."));
    } finally {
      setLoadingLog(false);
    }
  }

  async function reload() {
    setAsking(true);
    try {
      const res = await apiFetch<{ accounts: SiteAccountDTO[] }>("/api/browser/accounts");
      setList(res.accounts);
    } catch {
      // The list stays as it is.
    }
    await Promise.all([loadService(true), loadLog()]);
    setAsking(false);
  }

  const working = (id: string, on: boolean) => setBusy((b) => ({ ...b, [id]: on }));

  async function change(account: SiteAccountDTO, body: Record<string, unknown>, done: string) {
    working(account.id, true);
    setError(null);
    try {
      const res = await apiFetch<{ account: SiteAccountDTO }>(`/api/browser/accounts/${account.id}`, { method: "PATCH", body: JSON.stringify(body) });
      setList((l) => l.map((a) => (a.id === account.id ? res.account : a)));
      setNotice(done);
    } catch (err) {
      setError(message(err, "That could not be changed."));
    } finally {
      working(account.id, false);
    }
  }

  async function forget(account: SiteAccountDTO) {
    if (!confirm(`Drop the session that is kept for "${account.name}"? The next run signs in anew, and may be asked for a CAPTCHA or a code again.`)) return;
    working(account.id, true);
    setError(null);
    try {
      const res = await apiFetch<{ account: SiteAccountDTO }>(`/api/browser/accounts/${account.id}/session`, { method: "DELETE" });
      setList((l) => l.map((a) => (a.id === account.id ? res.account : a)));
      setNotice(`The session of "${account.name}" was dropped.`);
    } catch (err) {
      setError(message(err, "The session could not be dropped."));
    } finally {
      working(account.id, false);
    }
  }

  async function byHand(account: SiteAccountDTO) {
    working(account.id, true);
    setError(null);
    try {
      const res = await apiFetch<{ link: string }>(`/api/browser/accounts/${account.id}/session`, { method: "POST", body: "{}" });
      router.push(res.link);
    } catch (err) {
      setError(message(err, "The site could not be opened."));
      working(account.id, false);
    }
  }

  async function remove(account: SiteAccountDTO) {
    const used = account.projects > 0 ? ` ${account.projects} project${account.projects === 1 ? " names" : "s name"} it and will be without it.` : "";
    if (!confirm(`Remove the account "${account.name}"?${used} What was done with it stays in the log.`)) return;
    working(account.id, true);
    setError(null);
    try {
      await apiFetch(`/api/browser/accounts/${account.id}`, { method: "DELETE" });
      setList((l) => l.filter((a) => a.id !== account.id));
      setNotice(`"${account.name}" was removed.`);
    } catch (err) {
      setError(message(err, "The account could not be removed."));
      working(account.id, false);
    }
  }

  function saved(account: SiteAccountDTO, sessionDropped: boolean) {
    setList((l) => (l.some((a) => a.id === account.id) ? l.map((a) => (a.id === account.id ? account : a)) : [...l, account].sort((a, b) => a.name.localeCompare(b.name))));
    setNotice(`"${account.name}" is saved.${sessionDropped ? " What signs in was changed, so the session that was kept was dropped." : ""}`);
    setForm(null);
  }

  const ready = status.configured && status.reachable !== false;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Browser"
        description="The browser your agents work in: they open sites, read them and act on them, and sign in with the accounts saved here. What a site checks of a person is left to a person."
        actions={
          <>
            <Button variant="ghost" loading={asking} onClick={() => void reload()}><Icon name="refresh" size={16} /> Refresh</Button>
            {canManage && !form && <Button onClick={() => { setForm({ mode: "new" }); setNotice(null); }}><Icon name="plus" /> New account</Button>}
          </>
        }
      />

      {notice && <Alert tone="ok">{notice}</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}

      {waiting.length > 0 && (
        <section className="card border-warn/50" data-testid="browser-waiting">
          <header className="border-b border-line px-5 py-4">
            <h2 className="text-sm font-semibold text-ink">Waiting for you</h2>
            <p className="mt-0.5 text-xs text-ink-3">A page that needs a person. Open it, do what it asks, and hand it back.</p>
          </header>
          <ul className="divide-y divide-line">
            {waiting.map((w) => (
              <li key={w.id} className="flex flex-col gap-3 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 space-y-0.5">
                  <p className="text-sm text-ink">{w.reason}</p>
                  <p className="text-xs text-ink-3">
                    {w.kind === "owner" ? "A sign-in by hand" : [w.projectTitle, w.taskTitle, w.agentName ? `by ${w.agentName}` : ""].filter(Boolean).join(" · ")}
                    {" · "}waits until <DateTime at={w.deadline} />
                  </p>
                </div>
                <Link href={`/dashboard/browser/live/${w.id}`} className="btn btn-primary shrink-0">Open the page</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Card title="The browser service">
        <div className="space-y-2 text-sm" data-testid="browser-service">
          {!status.configured ? (
            <Alert tone="warn">
              No browser service is set up on this server (<span className="mono">BROWSER_URL</span>). Until then agents are not handed the tool “Work in a browser”.
              The service runs apart from the app; <span className="mono">scripts/host/browser</span> in the repository has it, and the README says how to start it.
            </Alert>
          ) : status.reachable === false ? (
            <Alert tone="danger">{status.error ?? "The browser service does not answer."}</Alert>
          ) : (
            <>
              <p className="text-ink">
                <Badge tone="ok">answers</Badge>{" "}
                <span className="mono">{status.product ?? "A browser"}</span>
                {status.where ? <> at <span className="mono">{status.where}</span></> : null}
              </p>
              <p className="text-ink-2">
                {use.pages} of at most {maxPages} {maxPages === 1 ? "page" : "pages"} open
                {use.runs > 0 ? `, for ${use.runs} ${use.runs === 1 ? "run" : "runs"}` : ""}
                {use.waiting > 0 ? `; ${use.waiting} ${use.waiting === 1 ? "waits" : "wait"} for a person` : ""}.
              </p>
              {status.filtered === true ? (
                <p className="text-ink-2">
                  Pages cannot reach private networks: the service refuses those addresses
                  {status.allowPrivate.length > 0 ? <> (except <span className="mono">{status.allowPrivate.join(", ")}</span>, which it was told to let through)</> : null}.
                </p>
              ) : (
                <Alert tone="warn">
                  This service does not say whether it keeps pages from private networks. The app does not open such an address itself, but a page can lead a browser there:
                  make sure this browser cannot reach what it must not, or use the service of this repository.
                </Alert>
              )}
              {status.userAgent && (
                <p className="break-all text-xs text-ink-3">
                  It tells sites what it is, and nothing is put in its place: <span className="mono">{status.userAgent}</span>
                </p>
              )}
            </>
          )}
        </div>
      </Card>

      {form && (
        <Card title={form.mode === "new" ? "New site account" : `Change ${form.account.name}`}>
          <AccountForm key={form.mode === "edit" ? form.account.id : "new"} initial={form.mode === "edit" ? form.account : undefined} onSaved={saved} onCancel={() => setForm(null)} />
        </Card>
      )}

      {list.length === 0 ? (
        <EmptyState
          title={canManage ? "No site account is saved yet" : "No site account is open to administrators"}
          description={canManage ? "Save the account your agents should sign in with. Without one they still read and use what a site shows to everyone." : "An owner saves the accounts and says whose projects may sign in with them."}
          action={canManage && !form ? <Button onClick={() => setForm({ mode: "new" })}><Icon name="plus" /> New account</Button> : undefined}
        />
      ) : (
        <div className="space-y-3">
          {list.map((a) => (
            <Card key={a.id}>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between" data-account={a.name}>
                <div className="min-w-0 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Icon name="browser" className="text-ink-3" />
                    <span className="font-medium text-ink">{a.name}</span>
                    <Badge tone={a.status === "enabled" ? "ok" : "neutral"}>{a.status === "enabled" ? "on" : "switched off"}</Badge>
                    <Badge tone="neutral">{ACCESS_LABEL[a.access]}</Badge>
                    <Badge tone={a.hasSession ? "signal" : "neutral"}>{a.hasSession ? "session kept" : "no session kept"}</Badge>
                  </div>
                  <p className="mono break-all text-xs text-ink-2">
                    {a.username} on {a.site}
                  </p>
                  <p className="mono break-all text-xs text-ink-3">{a.siteUrl}</p>
                  {a.notes && <p className="text-sm text-ink-2">{a.notes}</p>}
                  <p className="text-xs text-ink-3">
                    {a.hasSession && a.sessionSavedAt ? <>Session kept <RelativeTime at={a.sessionSavedAt} /> ({a.sessionCookies} {a.sessionCookies === 1 ? "cookie" : "cookies"}){" · "}</> : null}
                    {a.lastUsedAt ? <>last used <RelativeTime at={a.lastUsedAt} /></> : "never used"}
                    {" · "}
                    {a.projects === 0 ? "no project names it" : `${a.projects} project${a.projects === 1 ? " names" : "s name"} it`}
                  </p>
                  {a.lastProblem && <p className="text-xs text-danger">Last problem: {a.lastProblem}</p>}
                </div>
                {canManage && (
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <Toggle
                      checked={a.status === "enabled"}
                      onChange={(on) => void change(a, { status: on ? "enabled" : "disabled" }, on ? `"${a.name}" is switched on.` : `"${a.name}" is switched off: no project signs in with it until it is on again.`)}
                      disabled={busy[a.id]}
                      label={`Account ${a.name} is on`}
                    />
                    <Button variant="ghost" loading={busy[a.id]} disabled={!ready} title={ready ? undefined : "Needs the browser service"} onClick={() => void byHand(a)}>
                      <Icon name="test" size={16} /> Sign in by hand
                    </Button>
                    {a.hasSession && <Button variant="ghost" loading={busy[a.id]} onClick={() => void forget(a)}>Drop session</Button>}
                    <Button variant="ghost" onClick={() => { setForm({ mode: "edit", account: a }); setNotice(null); }}>Change</Button>
                    <Button variant="danger" loading={busy[a.id]} onClick={() => void remove(a)} aria-label={`Remove ${a.name}`}><Icon name="trash" /></Button>
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      <Card title="How agents work in the browser">
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-ink-2">
          <li>
            An agent that has the tool <span className="text-ink">Work in a browser</span> (Agents page) opens pages, reads them, clicks and types, in the projects of owners and administrators.
            It signs in with the accounts its project names: <span className="text-ink">the app types the password</span>, and no agent is shown it.
          </li>
          <li>
            <span className="text-ink">A CAPTCHA, a code sent to your phone, or any other check that a person is there is yours to do.</span> The app does not solve one and does not get around one.
            The task stops, you are told, you do it on the page as it is shown here, and the agent goes on from where you left it. A page waits {waitMinutes} {waitMinutes === 1 ? "minute" : "minutes"}; after that the agent is told that nobody came.
          </li>
          <li>
            <span className="text-ink">The session a sign-in left is kept with the account</span>, so the next run is let in without signing in again, and without asking you again.
            <span className="text-ink"> Sign in by hand</span> opens a site here for you to sign in once yourself: that session is kept the same way.
          </li>
          <li>
            On a site, an agent can do <span className="text-ink">whatever the account can</span>. Save an account with the rights the work needs, and no more, and say in its notes what to leave alone.
            Everything an agent does is written down below; what is typed into a password field never is.
          </li>
        </ul>
      </Card>

      <section className="card" data-testid="browser-log">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink">What was done in the browser</h2>
            <p className="mt-0.5 text-xs text-ink-3">
              {canManage ? "Every page that was opened and everything that was clicked, typed and chosen, newest first." : "What was done for your own projects, newest first."}
            </p>
          </div>
        </header>
        {log.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-3">Nothing has been done in the browser yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {log.map((entry) => (
              <LogRow key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
        {more && log.length > 0 && (
          <div className="border-t border-line px-5 py-3 text-center">
            <Button variant="ghost" loading={loadingLog} onClick={() => void loadLog(log[log.length - 1]?.createdAt)}>Show earlier</Button>
          </div>
        )}
      </section>
    </div>
  );
}
