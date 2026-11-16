"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { SerializedModel } from "@/lib/models";
import type { HealthStatus } from "@/lib/model-health";
import { CAPABILITY_LABELS, isMediaOnly } from "@/lib/capabilities";
import { apiFetch, ApiError } from "@/lib/client";
import { formatNumber } from "@/lib/format";
import { RelativeTime } from "@/components/time";
import { Badge, Button, Card, EmptyState, PageHeader, StatusDot, Toggle } from "@/components/ui";
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
}

/** How often the models are checked, in words. */
function every(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? "every day" : `every ${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? "every hour" : `every ${minutes / 60} hours`;
  return `every ${minutes} minutes`;
}

export function ModelsManager({
  initialModels,
  providers,
  isAdmin,
  initialHealth,
}: {
  initialModels: SerializedModel[];
  providers: ProviderLite[];
  isAdmin: boolean;
  initialHealth: HealthStatus;
}) {
  const [models, setModels] = useState(initialModels);
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

  const grouped = useMemo(() => {
    const map = new Map<string, SerializedModel[]>();
    for (const m of models) {
      const list = map.get(m.providerId) ?? [];
      list.push(m);
      map.set(m.providerId, list);
    }
    return [...map.entries()];
  }, [models]);

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
      const res = await apiFetch<{ model: SerializedModel }>(`/api/models/${m.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !m.enabled }),
      });
      patch(res.model);
    } catch {
      /* ignore */
    } finally {
      setBusy((b) => ({ ...b, [m.id]: undefined }));
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
      const fresh = await apiFetch<{ models: SerializedModel[] }>("/api/models");
      setModels(fresh.models);
      setTestNote({});
    } catch (err) {
      setCheckNote(err instanceof ApiError ? err.message : "The check could not be started.");
    } finally {
      setChecking(false);
    }
  }

  const canAdd = isAdmin && providers.length > 0;
  const hiddenCount = models.filter((m) => m.hidden).length;

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

      {isAdmin && models.length > 0 && (
        <div className="mb-5 rounded-md border border-line bg-surface-2/40 px-4 py-3 text-sm text-ink-2" data-testid="model-health">
          <p>
            {health.automatic
              ? `Every chat model that is switched on is asked for one word ${every(health.intervalMinutes)}, and soon after it is added.`
              : "The automatic check is switched off (MODEL_HEALTH_INTERVAL_MINUTES=0): models are checked with Test and with Check all now."}{" "}
            A model that fails is left out of the model lists and of the automatic choice until a check passes again; a failing model is asked again sooner.
          </p>
          <p className="mt-1 text-xs text-ink-3">
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
            <div key={pid}>
              <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-ink-3">
                {providerName.get(pid) ?? "Unknown provider"}
              </h2>
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
                              <span title="It failed its last check. It is left out of the model lists until a check passes again.">
                                <Badge tone="warn">left out of the lists</Badge>
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
                            {m.lastTestedAt && <span>tested <RelativeTime at={m.lastTestedAt} /></span>}
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
                          <div className="flex shrink-0 items-center gap-2">
                            <div className="flex items-center gap-2 pr-1">
                              <span className="text-xs text-ink-3">{m.enabled ? "on" : "off"}</span>
                              <Toggle
                                checked={m.enabled}
                                onChange={() => toggleEnabled(m)}
                                disabled={busy[m.id] === "toggle"}
                                label="Enabled"
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
