"use client";

import { useEffect, useState } from "react";
import type { ApiKeyDTO } from "@/lib/apikeys";
import { apiFetch, ApiError, copyText } from "@/lib/client";
import { formatCost, formatNumber } from "@/lib/format";
import { DateTime, Dotted, RelativeTime } from "@/components/time";
import type { WebhookDTO } from "@/lib/notifications";
import { API_SCOPES, type ApiScope } from "@/lib/limits";
import { Alert, Badge, Button, Card, Field, Input, Toggle, cn } from "@/components/ui";
import { Icon } from "@/components/icons";

const SCOPE_INFO: Record<ApiScope, { label: string; what: string }> = {
  chat: { label: "Chat", what: "Chat completions, with tools and streaming" },
  embeddings: { label: "Embeddings", what: "Text embeddings" },
  media: { label: "Media", what: "Images, speech and videos; reading the files" },
  projects: { label: "Projects", what: "Listing projects, starting runs, reading results" },
};

/** A secret that is shown once, with a button to copy it. */
function Secret({ label, value, note }: { label: string; value: string; note: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <div className="rounded-md border border-accent/60 bg-accent-soft p-3">
      <p className="text-sm font-medium text-ink">{label}</p>
      <div className="mt-2 flex items-center gap-2">
        <code className="mono min-w-0 flex-1 select-all break-all rounded bg-canvas px-2.5 py-1.5 text-xs text-ink" data-testid="secret-value">
          {value}
        </code>
        <Button
          type="button"
          variant="ghost"
          onClick={async () => {
            setCopied(await copyText(value));
            setTimeout(() => setCopied(null), 2000);
          }}
        >
          <Icon name={copied ? "check" : "copy"} size={15} />
          <span aria-live="polite">{copied === null ? "Copy" : copied ? "Copied" : "Select it and copy by hand"}</span>
        </Button>
      </div>
      <p className="mt-2 text-xs text-ink-2">{note}</p>
    </div>
  );
}

/** When a key stops working, or that it already has. */
function KeyExpiry({ at }: { at: number }) {
  // Which of the two it is depends on the clock, so it is decided in the browser.
  const [expired, setExpired] = useState(false);
  useEffect(() => setExpired(at < Date.now()), [at]);
  return expired ? <>expired</> : <>expires <DateTime at={at} /></>;
}

function WebhookCard({ initial }: { initial: WebhookDTO | null }) {
  const [hook, setHook] = useState(initial);
  const [url, setUrl] = useState(initial?.url ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function save(rotate = false) {
    setError(null);
    setNote(null);
    setBusy(rotate ? "rotate" : "save");
    try {
      const res = await apiFetch<{ webhook: WebhookDTO; secret: string | null }>(
        `/api/account/webhook${rotate ? "?rotate=1" : ""}`,
        { method: "PUT", body: JSON.stringify({ url: url.trim(), enabled }) },
      );
      setHook(res.webhook);
      if (res.secret) setSecret(res.secret);
      else setNote("Saved.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the webhook");
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setError(null);
    setNote(null);
    setBusy("test");
    try {
      const res = await apiFetch<{ webhook: WebhookDTO | null }>("/api/account/webhook/test", { method: "POST" });
      if (res.webhook) setHook(res.webhook);
      setNote("The test message arrived: the address answered with success.");
    } catch (err) {
      setError(err instanceof ApiError ? `The test message did not arrive: ${err.message}` : "The test failed");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!confirm("Remove the webhook? Notifications then only show in the dashboard.")) return;
    setBusy("remove");
    try {
      await apiFetch("/api/account/webhook", { method: "DELETE" });
      setHook(null);
      setUrl("");
      setSecret(null);
      setNote(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove the webhook");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card
      id="notifications"
      title="Notification webhook"
      description="Send your notifications (a run finished, a video is ready, a schedule could not start) to an address of yours as well: a chat channel's incoming webhook, or your own service."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="space-y-4"
      >
        {error && <Alert tone="danger">{error}</Alert>}
        {note && <Alert tone="ok">{note}</Alert>}
        {secret && (
          <Secret
            label="Signing secret"
            value={secret}
            note="Shown this once. Every delivery carries an x-nexus-signature header: t=<unix time>,v1=<HMAC-SHA256 of “<time>.<body>” with this secret>. Check it to know that a message is from this server."
          />
        )}
        <Field
          label="Address"
          htmlFor="wh-url"
          hint="Receives a POST with JSON: event, title, body, url, and the same message as text and content (the fields Slack and Discord webhooks read)."
        >
          <Input id="wh-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://hooks.example.com/…" className="mono" />
        </Field>
        <div className="flex items-center justify-between gap-4">
          <div className="text-sm">
            <p className="text-ink">Deliver notifications</p>
            {hook && (
              <p className="text-xs text-ink-3">
                {hook.lastStatus === "ok" && hook.lastDeliveredAt
                  ? <>Last delivery <RelativeTime at={hook.lastDeliveredAt} />.</>
                  : hook.lastStatus === "error"
                    ? `Last delivery failed: ${hook.lastError ?? "no details"}. Failed deliveries are tried again for a few hours.`
                    : "Nothing was delivered yet."}
              </p>
            )}
          </div>
          <Toggle checked={enabled} onChange={setEnabled} label="Deliver notifications" />
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {hook && (
            <>
              <Button type="button" variant="danger" onClick={remove} loading={busy === "remove"}>
                Remove
              </Button>
              <Button type="button" variant="ghost" onClick={() => void save(true)} loading={busy === "rotate"} title="Make a new signing secret; the old one stops working">
                New secret
              </Button>
              <Button type="button" variant="ghost" onClick={test} loading={busy === "test"}>
                <Icon name="send" size={15} /> Send a test
              </Button>
            </>
          )}
          <Button type="submit" loading={busy === "save"} disabled={!url.trim()}>
            {hook ? "Save" : "Add webhook"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function ApiKeysCard({
  initial,
  models,
  baseUrl,
  chooses,
  inPlan,
  notInPlan,
}: {
  initial: ApiKeyDTO[];
  models: { id: string; label: string }[];
  baseUrl: string;
  /** Whether a key names its models. A user's key does not: it sends "auto", and the app chooses. */
  chooses: boolean;
  /** Whether the plan of the account has API keys. Without them no key is made, and the ones there do not answer. */
  inPlan: boolean;
  /** What is said where it has not. */
  notInPlan?: string;
}) {
  const [keys, setKeys] = useState(initial);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Set<ApiScope>>(new Set(["chat"]));
  const [restrict, setRestrict] = useState(false);
  const [modelIds, setModelIds] = useState<Set<string>>(new Set());
  const [rate, setRate] = useState("");
  const [tokens, setTokens] = useState("");
  const [cost, setCost] = useState("");
  const [days, setDays] = useState("");
  const [created, setCreated] = useState<{ secret: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const active = keys.filter((k) => !k.revokedAt);
  const revoked = keys.filter((k) => k.revokedAt);
  const modelLabel = new Map(models.map((m) => [m.id, m.label] as const));

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy("create");
    const number = (value: string) => (value.trim() ? Number(value) : null);
    try {
      const res = await apiFetch<{ key: ApiKeyDTO; secret: string }>("/api/account/api-keys", {
        method: "POST",
        body: JSON.stringify({
          name,
          scopes: [...scopes],
          modelRowIds: restrict && modelIds.size > 0 ? [...modelIds] : null,
          rateLimitPerMinute: number(rate),
          monthlyTokenLimit: number(tokens),
          monthlyCostLimit: number(cost),
          expiresInDays: number(days),
        }),
      });
      setKeys((list) => [res.key, ...list]);
      setCreated({ secret: res.secret, name: res.key.name });
      setOpen(false);
      setName("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the key");
    } finally {
      setBusy(null);
    }
  }

  async function revoke(key: ApiKeyDTO) {
    if (!confirm(`Revoke the key "${key.name}"? Whatever uses it stops working at once. This cannot be undone.`)) return;
    setBusy(key.id);
    try {
      const res = await apiFetch<{ key: ApiKeyDTO }>(`/api/account/api-keys/${key.id}`, { method: "DELETE" });
      setKeys((list) => list.map((k) => (k.id === key.id ? res.key : k)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not revoke the key");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card
      id="api-keys"
      title="API keys"
      description="Use this server from your own programs. The API speaks the OpenAI format, so existing clients work when they are pointed at it. A key acts as you, within what it is allowed."
      actions={
        !open && inPlan ? (
          <Button variant="ghost" onClick={() => setOpen(true)}>
            <Icon name="plus" /> New key
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {!inPlan && (
          <div data-testid="keys-not-in-plan">
            <Alert tone="neutral">
              {notInPlan ?? "API keys are not part of your plan."}{" "}
              <a href="/dashboard/plans" className="font-medium text-accent-ink hover:underline">
                See the plans
              </a>
              {keys.length > 0 && " The keys you made are kept, and answer again when your plan has them."}
            </Alert>
          </div>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
        {created && (
          <>
            <Secret
              label={`Key “${created.name}”`}
              value={created.secret}
              note="Shown this once: only a fingerprint of it is stored, so it cannot be shown again. Keep it like a password."
            />
            <pre className="mono overflow-x-auto rounded-md border border-line bg-surface-2 p-3 text-[11px] leading-relaxed text-ink-2">
{`curl ${baseUrl}/api/v1/chat/completions \\
  -H "Authorization: Bearer ${created.secret.slice(0, 10)}…" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${chooses ? "<a name from GET /api/v1/models>" : "auto"}", "messages": [{"role": "user", "content": "Hello"}]}'`}
            </pre>
          </>
        )}

        {open && (
          <form onSubmit={create} className="space-y-4 rounded-md border border-line bg-surface-2/40 p-4">
            <Field label="Name" htmlFor="ak-name" hint="What uses the key, so you can tell keys apart.">
              <Input id="ak-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="e.g. Website backend" />
            </Field>
            <Field label="May use">
              <ul className="grid gap-1.5 sm:grid-cols-2">
                {API_SCOPES.map((scope) => (
                  <li key={scope}>
                    <label className={cn("flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 text-sm", scopes.has(scope) ? "border-accent/60 bg-accent-soft" : "border-line")}>
                      <input
                        type="checkbox"
                        className="mt-0.5 accent-current"
                        checked={scopes.has(scope)}
                        onChange={() =>
                          setScopes((prev) => {
                            const next = new Set(prev);
                            if (next.has(scope)) next.delete(scope);
                            else next.add(scope);
                            return next;
                          })
                        }
                      />
                      <span>
                        <span className="font-medium text-ink">{SCOPE_INFO[scope].label}</span>
                        <span className="block text-xs text-ink-3">{SCOPE_INFO[scope].what}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Requests per minute" htmlFor="ak-rate" hint="Empty: 120.">
                <Input id="ak-rate" type="number" min={1} max={6000} value={rate} onChange={(e) => setRate(e.target.value)} />
              </Field>
              <Field label="Tokens per month" htmlFor="ak-tokens" hint="Empty: no limit.">
                <Input id="ak-tokens" type="number" min={1} value={tokens} onChange={(e) => setTokens(e.target.value)} />
              </Field>
              {chooses && (
                <Field label="Cost per month ($)" htmlFor="ak-cost" hint="By the prices set on the models. Empty: no limit.">
                  <Input id="ak-cost" type="number" min={0} step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} />
                </Field>
              )}
              <Field label="Expires after (days)" htmlFor="ak-days" hint="Empty: it does not expire.">
                <Input id="ak-days" type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} />
              </Field>
            </div>
            <div className={chooses ? undefined : "hidden"}>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-2">
                <input type="checkbox" className="accent-current" checked={restrict} onChange={(e) => setRestrict(e.target.checked)} />
                Only some models
              </label>
              {restrict &&
                (models.length === 0 ? (
                  <p className="mt-2 text-xs text-ink-3">No model is enabled.</p>
                ) : (
                  <ul className="mt-2 grid max-h-48 gap-1 overflow-y-auto sm:grid-cols-2">
                    {models.map((m) => (
                      <li key={m.id}>
                        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-2">
                          <input
                            type="checkbox"
                            className="accent-current"
                            checked={modelIds.has(m.id)}
                            onChange={() =>
                              setModelIds((prev) => {
                                const next = new Set(prev);
                                if (next.has(m.id)) next.delete(m.id);
                                else next.add(m.id);
                                return next;
                              })
                            }
                          />
                          <span className="truncate">{m.label}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={busy === "create"} disabled={!name.trim() || scopes.size === 0 || (restrict && modelIds.size === 0)}>
                Create key
              </Button>
            </div>
          </form>
        )}

        {active.length === 0 && !open ? (
          <p className="text-sm text-ink-3">No key yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {active.map((key) => (
              <li key={key.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Icon name="key" size={15} className="text-ink-3" />
                    <span className="text-sm font-medium text-ink">{key.name}</span>
                    <code className="mono text-xs text-ink-3">{key.prefix}…</code>
                    {key.scopes.map((scope) => (
                      <Badge key={scope}>{SCOPE_INFO[scope].label}</Badge>
                    ))}
                  </div>
                  <p className="mt-1 text-xs text-ink-3">
                    <Dotted
                      parts={[
                        key.lastUsedAt ? <>used <RelativeTime at={key.lastUsedAt} /></> : "never used",
                        `this month: ${formatNumber(key.monthTokens)} tokens${key.monthlyTokenLimit ? ` of ${formatNumber(key.monthlyTokenLimit)}` : ""}` +
                          (key.monthCost > 0 || key.monthlyCostLimit ? `, ${formatCost(key.monthCost)}${key.monthlyCostLimit ? ` of ${formatCost(key.monthlyCostLimit)}` : ""}` : ""),
                        `${key.rateLimitPerMinute ?? 120} requests a minute`,
                        !chooses
                          ? null
                          : key.modelRowIds
                            ? `${key.modelRowIds.length} ${key.modelRowIds.length === 1 ? "model" : "models"}: ${key.modelRowIds.map((id) => modelLabel.get(id) ?? "a removed model").join(", ")}`
                            : "all models",
                        key.expiresAt ? <KeyExpiry at={key.expiresAt} /> : null,
                      ]}
                    />
                  </p>
                </div>
                <Button variant="danger" onClick={() => revoke(key)} loading={busy === key.id}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
        {revoked.length > 0 && (
          <p className="text-xs text-ink-3">
            Revoked: {revoked.map((k) => `${k.name} (${k.prefix}…)`).join(", ")}.
          </p>
        )}
        <p className="text-xs text-ink-3">
          Endpoints, under <code className="mono">{baseUrl}/api/v1</code>: <code className="mono">models</code>,{" "}
          <code className="mono">chat/completions</code>, <code className="mono">embeddings</code>,{" "}
          <code className="mono">images/generations</code>, <code className="mono">audio/speech</code>,{" "}
          <code className="mono">videos</code>, <code className="mono">projects</code> and{" "}
          <code className="mono">projects/&lt;id&gt;/runs</code>. The README describes each.
        </p>
      </div>
    </Card>
  );
}

export function IntegrationsClient({
  webhook,
  apiKeys,
  models,
  baseUrl,
  chooses = true,
  keysInPlan = true,
  keysNotInPlan,
}: {
  webhook: WebhookDTO | null;
  apiKeys: ApiKeyDTO[];
  /** The models a key can be limited to. Empty for someone who chooses none. */
  models: { id: string; label: string }[];
  baseUrl: string;
  /** Whether the account is shown the setup, and so names models. */
  chooses?: boolean;
  /** Whether the plan of the account has API keys. */
  keysInPlan?: boolean;
  keysNotInPlan?: string;
}) {
  return (
    <div className="mt-6 space-y-6">
      <ApiKeysCard initial={apiKeys} models={models} baseUrl={baseUrl} chooses={chooses} inPlan={keysInPlan} notInPlan={keysNotInPlan} />
      <WebhookCard initial={webhook} />
    </div>
  );
}
