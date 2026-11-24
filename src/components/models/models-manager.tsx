"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { SerializedModel } from "@/lib/models";
import type { HealthStatus } from "@/lib/model-health";
import type { UsersModel } from "@/lib/model-choice";
import { CHOICE_LABEL } from "@/lib/model-choice-rules";
import { CAPABILITY_LABELS, isMediaOnly } from "@/lib/capabilities";
import { apiFetch, ApiError } from "@/lib/client";
import { formatNumber } from "@/lib/format";
import { sortModels } from "@/lib/model-rank";
import { TIERS, tierLabel, type Tier } from "@/lib/roles";
import { RelativeTime, TimeText } from "@/components/time";
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Select, StatusDot, Toggle } from "@/components/ui";
import { Icon } from "@/components/icons";
import { ModelForm } from "./model-form";

interface ProviderLite {
  id: string;
  name: string;
  adapterImplemented: boolean;
  /** Whether its adapter can generate images, videos or speech. */
  supportsMedia: boolean;
  /** What its adapter can do besides chat. */
  abilities: { image: boolean; video: boolean; audio: boolean; embed: boolean; tools: boolean };
  status: "enabled" | "disabled";
  /** Where it stands among the providers: the lowest first. */
  priority: number;
}

/** How often the models are checked, in words. */
function every(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? "every day" : `every ${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? "every hour" : `every ${minutes / 60} hours`;
  return `every ${minutes} minutes`;
}

/** A time of day, with the day when it is not today: "14:05", "09:30 on 24 Nov". */
function clock(date: Date): string {
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const today = new Date();
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  return sameDay ? time : `${time} on ${date.toLocaleDateString([], { day: "numeric", month: "short" })}`;
}
function ClockTime({ at }: { at: Date }) {
  return <TimeText at={at} text={clock} />;
}

export function ModelsManager({
  initialModels,
  providers,
  isAdmin,
  initialHealth,
  initialUsers,
}: {
  initialModels: SerializedModel[];
  providers: ProviderLite[];
  isAdmin: boolean;
  initialHealth: HealthStatus;
  /** What users, who choose no model, work with: kind by kind. */
  initialUsers: UsersModel[];
}) {
  const [models, setModels] = useState(initialModels);
  const [users, setUsers] = useState(initialUsers);
  const [health, setHealth] = useState(initialHealth);
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState<string | null>(null);
  const [form, setForm] = useState<{ mode: "new" | "edit"; model?: SerializedModel } | null>(null);
  const [busy, setBusy] = useState<Record<string, string | undefined>>({});
  const [testNote, setTestNote] = useState<Record<string, { ok: boolean; text: string } | undefined>>({});

  const providerName = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of providers) m.set(p.id, p.name);
    return m;
  }, [providers]);
  const mediaProviders = useMemo(
    () => new Set(providers.filter((p) => p.supportsMedia).map((p) => p.id)),
    [providers],
  );

  // The providers are the categories, in their order (priority, then name);
  // in each, the highest and newest model first (model-rank.ts), as a
  // conversation lists them.
  const grouped = useMemo(() => {
    const map = new Map<string, SerializedModel[]>();
    for (const m of models) {
      const list = map.get(m.providerId) ?? [];
      list.push(m);
      map.set(m.providerId, list);
    }
    const order = new Map(providers.map((p, index) => [p.id, { priority: p.priority, name: p.name, index }] as const));
    return [...map.entries()]
      .sort(([a], [b]) => {
        const pa = order.get(a);
        const pb = order.get(b);
        if (!pa || !pb) return pa ? -1 : pb ? 1 : 0;
        return pa.priority - pb.priority || pa.name.localeCompare(pb.name, "en") || pa.index - pb.index;
      })
      .map(
        ([pid, list]) =>
          [
            pid,
            // As the list of a conversation has them: the newest of each class first, then the older ones.
            sortModels(list.map((m) => ({ modelId: m.modelId, name: m.displayName || m.modelId, position: m.position, outputPrice: m.outputPricePerMTok, model: m }))).map((ranked) => ranked.model),
          ] as const,
      );
  }, [models, providers]);

  function patch(m: SerializedModel) {
    setModels((list) => {
      const idx = list.findIndex((x) => x.id === m.id);
      if (idx === -1) return [m, ...list];
      const next = [...list];
      next[idx] = m;
      return next;
    });
  }

  async function toggleEnabled(m: SerializedModel) {
    setBusy((b) => ({ ...b, [m.id]: "toggle" }));
    try {
      const res = await apiFetch<{ model: SerializedModel; users?: UsersModel[] }>(`/api/models/${m.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !m.enabled }),
      });
      patch(res.model);
      if (res.users) setUsers(res.users);
    } catch {
      /* ignore */
    } finally {
      setBusy((b) => ({ ...b, [m.id]: undefined }));
    }
  }

  /** Mark a model for the work of users, or take the mark away. */
  async function toggleForUsers(m: SerializedModel) {
    setBusy((b) => ({ ...b, [m.id]: "users" }));
    try {
      const res = await apiFetch<{ model: SerializedModel; users?: UsersModel[] }>(`/api/models/${m.id}`, {
        method: "PATCH",
        body: JSON.stringify({ forUsers: !m.forUsers }),
      });
      patch(res.model);
      if (res.users) setUsers(res.users);
    } catch {
      /* ignore */
    } finally {
      setBusy((b) => ({ ...b, [m.id]: undefined }));
    }
  }

  /** The lowest role that may choose a model in a conversation. */
  async function setMinTier(m: SerializedModel, minTier: Tier) {
    setBusy((b) => ({ ...b, [m.id]: "tier" }));
    try {
      const res = await apiFetch<{ model: SerializedModel; users?: UsersModel[] }>(`/api/models/${m.id}`, { method: "PATCH", body: JSON.stringify({ minTier }) });
      patch(res.model);
    } catch {
      /* the row stays as it was */
    } finally {
      setBusy((b) => ({ ...b, [m.id]: undefined }));
    }
  }

  /** The same lowest role for every model of a provider. */
  const [bulk, setBulk] = useState<string | null>(null);
  async function setMinTierOfAll(pid: string, list: readonly SerializedModel[], minTier: Tier) {
    const changing = list.filter((m) => m.minTier !== minTier);
    if (changing.length === 0) return;
    if (!confirm(`Set the lowest role of ${changing.length} ${changing.length === 1 ? "model" : "models"} of ${providerName.get(pid) ?? "this provider"} to ${tierLabel(minTier)}?`)) return;
    setBulk(pid);
    try {
      for (const m of changing) {
        try {
          const res = await apiFetch<{ model: SerializedModel }>(`/api/models/${m.id}`, { method: "PATCH", body: JSON.stringify({ minTier }) });
          patch(res.model);
        } catch {
          /* that one stays as it was */
        }
      }
    } finally {
      setBulk(null);
    }
  }

  async function test(m: SerializedModel) {
    setBusy((b) => ({ ...b, [m.id]: "test" }));
    setTestNote((n) => ({ ...n, [m.id]: undefined }));
    try {
      const res = await apiFetch<{ ok: boolean; sample?: string; error?: string }>(
        `/api/models/${m.id}/test`,
        { method: "POST", body: JSON.stringify({}) },
      );
      patch({
        ...m,
        lastTestedAt: new Date(),
        lastTestStatus: res.ok ? "ok" : "error",
        lastTestError: res.ok ? null : res.error ?? "Test failed",
        checkFailures: res.ok ? 0 : m.checkFailures + 1,
        retryAt: null,
        hidden: m.enabled && !res.ok,
      });
      setTestNote((n) => ({
        ...n,
        [m.id]: { ok: res.ok, text: res.ok ? res.sample || "ok" : res.error || "Test failed" },
      }));
    } catch (err) {
      setTestNote((n) => ({
        ...n,
        [m.id]: { ok: false, text: err instanceof ApiError ? err.message : "Test failed" },
      }));
    } finally {
      setBusy((b) => ({ ...b, [m.id]: undefined }));
    }
  }

  async function remove(m: SerializedModel) {
    if (!confirm(`Delete model "${m.displayName || m.modelId}"?`)) return;
    setBusy((b) => ({ ...b, [m.id]: "delete" }));
    try {
      await apiFetch(`/api/models/${m.id}`, { method: "DELETE" });
      setModels((list) => list.filter((x) => x.id !== m.id));
    } catch {
      setBusy((b) => ({ ...b, [m.id]: undefined }));
    }
  }

  /** Check every model now, and show what the check found when it has ended. */
  async function checkAll() {
    setChecking(true);
    setCheckNote(null);
    try {
      const started = await apiFetch<{ health: HealthStatus }>("/api/models/health", { method: "POST", body: JSON.stringify({}) });
      let now = started.health;
      // A round asks one model after the other: with many models it takes minutes.
      for (let i = 0; now.running && i < 400; i++) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        now = (await apiFetch<{ health: HealthStatus }>("/api/models/health")).health;
      }
      setHealth(now);
      const fresh = await apiFetch<{ models: SerializedModel[]; users?: UsersModel[] }>("/api/models");
      setModels(fresh.models);
      // A check can change which model users work with.
      if (fresh.users) setUsers(fresh.users);
      setTestNote({});
    } catch (err) {
      setCheckNote(err instanceof ApiError ? err.message : "The check could not be started.");
    } finally {
      setChecking(false);
    }
  }

  // What depends on the time of day is shown once the page is live, so that
  // the server and the browser write the same page first.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const canAdd = isAdmin && providers.length > 0;
  const hiddenCount = models.filter((m) => m.hidden).length;
  // A model that did not answer a request a moment ago: the app does not choose it until its rest is over.
  const restsUntil = (m: SerializedModel): Date | null => {
    if (!m.retryAt || now === null) return null;
    const until = new Date(m.retryAt);
    return until.getTime() > now ? until : null;
  };
  const switchedOn = models.filter((m) => m.enabled);
  const restingCount = switchedOn.filter((m) => !m.hidden && restsUntil(m)).length;
  const workingCount = switchedOn.filter((m) => m.lastTestStatus === "ok" && !restsUntil(m)).length;
  const uncheckedCount = switchedOn.filter((m) => !m.lastTestStatus).length;

  return (
    <div>
      <PageHeader
        title="Models"
        description="The catalog of models available through your providers."
        actions={
          canAdd && !form ? (
            <div className="flex flex-wrap gap-2">
              {models.length > 0 && (
                <Button variant="ghost" loading={checking} disabled={checking} onClick={checkAll}>
                  Check all now
                </Button>
              )}
              <Button onClick={() => setForm({ mode: "new" })}>
                <Icon name="plus" /> Add model
              </Button>
            </div>
          ) : undefined
        }
      />

      {!isAdmin && (
        <div className="mb-5" data-testid="models-view-only">
          <Alert tone="neutral">Models are changed by the owner of this installation. You can look at them here.</Alert>
        </div>
      )}

      {models.length > 0 && (
        <div className="mb-5 rounded-lg border border-line bg-surface-2/40 px-4 py-3 text-sm text-ink-2" data-testid="model-health">
          <p>
            {health.automatic
              ? `Every chat model that is switched on is asked for one word ${every(health.intervalMinutes)}, and soon after it is added.`
              : "The automatic check is switched off (MODEL_HEALTH_INTERVAL_MINUTES=0): models are checked with Test and with Check all now."}{" "}
            A model that fails is left out of the model lists and of the automatic choice until a check passes again; a failing model is asked again sooner.
          </p>
          <p className="mt-1" data-testid="model-standing">
            Real work counts as well: a model that answers a request is known to work. One that does not answer rests (the app does not choose it for a while), and after three
            requests in a row, or one answer that asking again does not change, it is left out like one that failed a check. A run then goes on with another model that works.
          </p>
          <p className="mt-1 text-xs text-ink-3">
            <span data-testid="model-counts">
              Of the {switchedOn.length} that {switchedOn.length === 1 ? "is" : "are"} switched on: {workingCount} {workingCount === 1 ? "works" : "work"}
              {restingCount > 0 ? `, ${restingCount} ${restingCount === 1 ? "rests" : "rest"}` : ""}
              {uncheckedCount > 0 ? `, ${uncheckedCount} ${uncheckedCount === 1 ? "was" : "were"} never asked` : ""}.
            </span>{" "}
            {hiddenCount === 0 ? "No model is left out now." : `${hiddenCount} ${hiddenCount === 1 ? "model is" : "models are"} left out now.`}
            {checking || health.running ? " A check is running." : ""}
            {!checking && health.last && health.last.endedAt ? (
              <>
                {" "}Last check <RelativeTime at={new Date(health.last.endedAt)} />: {health.last.checked} asked, {health.last.passed} answered, {health.last.failed} failed.
              </>
            ) : null}
            {" "}Image, video, speech and embedding models are not checked: a check would generate one each time.
          </p>
          {checkNote && <p className="mt-1 text-xs text-danger">{checkNote}</p>}
        </div>
      )}

      {models.length > 0 && (
        <div className="mb-5 rounded-lg border border-line bg-surface-2/40 px-4 py-3 text-sm text-ink-2" id="users-models">
          <p>
            In a conversation a user chooses among the models marked <span className="font-medium text-ink">for users</span> (among all of
            them while none is marked), in these categories and in this order, from the <span className="font-medium text-ink">lowest role</span>{" "}
            each model is set to: a model above an account&apos;s role is shown to it, and cannot be chosen. Everywhere else, and where the choice is
            left to it, the app chooses: a model that is marked, of the account&apos;s role; while no model of a kind is marked, the cheapest of
            that kind that is switched on.
          </p>
          <ul className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
            {users.map((u) => (
              <li key={u.kind} data-users-kind={u.kind}>
                <span className="text-ink-3">{CHOICE_LABEL[u.kind]}:</span>{" "}
                {u.first ? (
                  <>
                    <span className="mono text-ink">{u.first.label}</span>
                    <span className="text-ink-3">
                      {u.marked > 0 ? " (marked)" : " (none marked: the cheapest)"}
                      {u.choices > 1 ? `, then ${u.choices - 1} more` : ""}
                    </span>
                  </>
                ) : (
                  <span className="text-warn">{u.marked > 0 ? "the marked ones cannot be asked now" : "no model can do this: users cannot"}</span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-ink-3">
            Agents work with the models they are set to, for everyone. An admin and an owner choose among all models. The order within a provider is
            read from the names, the highest version first; where that is wrong, give a model a place of its own under Edit.
          </p>
        </div>
      )}

      {isAdmin && providers.length === 0 && (
        <EmptyState
          title="Add a provider first"
          description="Models belong to a provider connection. Create a provider, then register or discover its models."
        />
      )}

      {form && (
        <div className="mb-6">
          <Card title={form.mode === "new" ? "Add model manually" : `Edit ${form.model?.modelId}`}>
            <ModelForm
              providers={providers.map((p) => ({
                id: p.id,
                name: p.name,
                supportsMedia: p.supportsMedia,
                abilities: p.abilities,
              }))}
              initial={form.model}
              onSaved={(m) => {
                patch(m);
                setForm(null);
              }}
              onCancel={() => setForm(null)}
            />
          </Card>
        </div>
      )}

      {models.length === 0 && providers.length > 0 ? (
        <EmptyState
          title="No models in the catalog"
          description="Use Discover on a provider, or add a model manually."
        />
      ) : (
        <div className="space-y-6">
          {grouped.map(([pid, list]) => (
            <div key={pid} data-provider-group={providerName.get(pid) ?? ""}>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1">
                <h2 className="text-sm font-semibold text-ink">
                  {providerName.get(pid) ?? "Unknown provider"} <span className="font-normal text-ink-3">· {list.length}</span>
                </h2>
                {isAdmin && list.length > 1 && (
                  <label className="flex items-center gap-2 text-xs text-ink-3">
                    Lowest role for all of these
                    <Select
                      className="w-28 py-1 text-xs"
                      aria-label={`Lowest role for all models of ${providerName.get(pid) ?? "this provider"}`}
                      value=""
                      disabled={bulk === pid}
                      onChange={(e) => {
                        if (e.target.value) void setMinTierOfAll(pid, list, e.target.value as Tier);
                      }}
                    >
                      <option value="">{bulk === pid ? "Setting…" : "Choose…"}</option>
                      {TIERS.map((tier) => (
                        <option key={tier} value={tier}>
                          {tierLabel(tier)}
                        </option>
                      ))}
                    </Select>
                  </label>
                )}
              </div>
              <Card className="overflow-hidden">
                <ul className="-m-5 divide-y divide-line">
                  {list.map((m) => (
                    <li key={m.id} className="px-5 py-4">
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="mono text-sm font-medium text-ink">{m.modelId}</span>
                            {m.displayName && <span className="text-xs text-ink-3">{m.displayName}</span>}
                            <Badge tone={m.source === "discovered" ? "info" : "neutral"}>{m.source}</Badge>
                            {m.lastTestStatus && (
                              <Badge tone={m.lastTestStatus === "ok" ? "ok" : "danger"}>
                                <StatusDot tone={m.lastTestStatus === "ok" ? "ok" : "danger"} />
                                test {m.lastTestStatus}
                              </Badge>
                            )}
                            {m.hidden && (
                              <span title="It failed its last check, or did not answer in real work. It is left out of the model lists until a check passes again.">
                                <Badge tone="warn">left out of the lists</Badge>
                              </span>
                            )}
                            {m.enabled && !m.hidden && restsUntil(m) && (
                              <span title="It did not answer a request a moment ago. The app does not choose it by itself until then; it stays in the lists, and is asked again when its rest is over.">
                                <Badge tone="warn">
                                  rests until <ClockTime at={restsUntil(m)!} />
                                </Badge>
                              </span>
                            )}
                            {m.hidden && restsUntil(m) && (
                              <span className="text-xs text-ink-3" title="Its provider said when to ask again: the check does not ask before that.">
                                asked again after <ClockTime at={restsUntil(m)!} />
                              </span>
                            )}
                            {m.forUsers && (
                              <span title="The app works with this model where a user would have chosen one.">
                                <Badge tone="signal">for users</Badge>
                              </span>
                            )}
                            {m.minTier !== "free" && (
                              <span title={`In a conversation, ${tierLabel(m.minTier)} and above choose it.`} data-min-tier={m.minTier}>
                                <Badge tone="info">from {tierLabel(m.minTier)}</Badge>
                              </span>
                            )}
                            {m.position !== null && (
                              <span className="text-xs text-ink-3" title="The place an owner gave it among the models of its provider.">
                                place {m.position}
                              </span>
                            )}
                          </div>
                          {m.capabilities.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {m.capabilities.map((c) => (
                                <span
                                  key={c.capability}
                                  className="rounded border border-line px-1.5 py-0.5 text-[11px] text-ink-2"
                                  title={c.verified ? "verified" : "declared"}
                                >
                                  {CAPABILITY_LABELS[c.capability]}
                                  {c.verified ? " ✓" : ""}
                                </span>
                              ))}
                            </div>
                          )}
                          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-3">
                            {m.contextWindow != null && <span>ctx {formatNumber(m.contextWindow)}</span>}
                            {m.inputPricePerMTok != null && <span>in ${m.inputPricePerMTok}/1M</span>}
                            {m.outputPricePerMTok != null && <span>out ${m.outputPricePerMTok}/1M</span>}
                            {m.pricePerImage != null && <span>${m.pricePerImage}/image</span>}
                            {m.pricePerSecond != null && <span>${m.pricePerSecond}/second</span>}
                            {m.pricePerMChars != null && <span>${m.pricePerMChars}/1M characters</span>}
                            {m.lastTestedAt && (
                              <span title="When it last answered, or failed: a check, or a request of real work.">
                                {m.lastTestStatus === "error" ? "failed" : "answered"} <RelativeTime at={m.lastTestedAt} />
                              </span>
                            )}
                          </div>
                          {testNote[m.id] && (
                            <p
                              className={`mt-2 rounded border px-2.5 py-1.5 text-xs ${
                                testNote[m.id]!.ok
                                  ? "border-ok/30 bg-ok/10 text-ok"
                                  : "border-danger/30 bg-danger/10 text-danger"
                              }`}
                            >
                              {testNote[m.id]!.ok ? "Reply: " : ""}
                              {testNote[m.id]!.text}
                            </p>
                          )}
                        </div>

                        {isAdmin && (
                          <div className="flex shrink-0 flex-wrap items-center gap-2">
                            <label className="flex items-center gap-1.5 pr-1 text-xs text-ink-3" title="The lowest role that may choose this model in a conversation.">
                              from
                              <Select
                                className="w-24 py-1 text-xs"
                                aria-label={`Lowest role: ${m.displayName || m.modelId}`}
                                value={m.minTier}
                                disabled={busy[m.id] === "tier" || bulk === pid}
                                onChange={(e) => void setMinTier(m, e.target.value as Tier)}
                              >
                                {TIERS.map((tier) => (
                                  <option key={tier} value={tier}>
                                    {tierLabel(tier)}
                                  </option>
                                ))}
                              </Select>
                            </label>
                            <div className="flex items-center gap-2 pr-1">
                              <span className="text-xs text-ink-3">{m.enabled ? "on" : "off"}</span>
                              <Toggle
                                checked={m.enabled}
                                onChange={() => toggleEnabled(m)}
                                disabled={busy[m.id] === "toggle"}
                                label="Enabled"
                              />
                            </div>
                            <div className="flex items-center gap-2 pr-1" title="Marked: the app works with this model where a user would have chosen one.">
                              <span className="text-xs text-ink-3">for users</span>
                              <Toggle
                                checked={m.forUsers}
                                onChange={() => toggleForUsers(m)}
                                disabled={busy[m.id] === "users"}
                                label={`For users: ${m.displayName || m.modelId}`}
                              />
                            </div>
                            {isMediaOnly(m.capabilities.map((c) => c.capability)) ? (
                              // The test is a chat request, which such a model cannot answer.
                              // Creative Studio offers it only on a provider that can generate media;
                              // an embedding model is tried by giving it to a knowledge collection.
                              m.capabilities.some((c) => c.capability === "embeddings") &&
                              !m.capabilities.some((c) => /_generation$/.test(c.capability)) ? (
                                <Link href="/dashboard/knowledge" className="btn-ghost" title="Use this model for a knowledge collection">
                                  <Icon name="knowledge" /> Use
                                </Link>
                              ) : (
                                mediaProviders.has(m.providerId) && (
                                  <Link href="/dashboard/studio" className="btn-ghost" title="Try this model in Creative Studio">
                                    <Icon name="studio" /> Try
                                  </Link>
                                )
                              )
                            ) : (
                              <Button variant="ghost" loading={busy[m.id] === "test"} disabled={!!busy[m.id]} onClick={() => test(m)}>
                                <Icon name="test" /> Test
                              </Button>
                            )}
                            <Button variant="ghost" disabled={!!busy[m.id]} onClick={() => setForm({ mode: "edit", model: m })}>
                              Edit
                            </Button>
                            <Button variant="danger" loading={busy[m.id] === "delete"} disabled={!!busy[m.id]} onClick={() => remove(m)}>
                              <Icon name="trash" />
                            </Button>
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
