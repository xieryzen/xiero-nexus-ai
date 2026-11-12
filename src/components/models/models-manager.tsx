"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { SerializedModel } from "@/lib/models";
import { CAPABILITY_LABELS, isMediaOnly } from "@/lib/capabilities";
import { apiFetch, ApiError } from "@/lib/client";
import { formatRelative } from "@/lib/format";
import { Badge, Button, Card, EmptyState, PageHeader, StatusDot, Toggle } from "@/components/ui";
import { Icon } from "@/components/icons";
import { ModelForm } from "./model-form";

interface ProviderLite {
  id: string;
  name: string;
  adapterImplemented: boolean;
  /** Whether its adapter can generate images or videos. */
  supportsMedia: boolean;
  status: "enabled" | "disabled";
}

export function ModelsManager({
  initialModels,
  providers,
  isAdmin,
}: {
  initialModels: SerializedModel[];
  providers: ProviderLite[];
  isAdmin: boolean;
}) {
  const [models, setModels] = useState(initialModels);
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

  const canAdd = isAdmin && providers.length > 0;

  return (
    <div>
      <PageHeader
        title="Models"
        description="The catalog of models available through your providers."
        actions={
          canAdd && !form ? (
            <Button onClick={() => setForm({ mode: "new" })}>
              <Icon name="plus" /> Add model
            </Button>
          ) : undefined
        }
      />

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
              providers={providers.map((p) => ({ id: p.id, name: p.name, supportsMedia: p.supportsMedia }))}
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
                            {m.contextWindow != null && <span>ctx {m.contextWindow.toLocaleString()}</span>}
                            {m.inputPricePerMTok != null && <span>in ${m.inputPricePerMTok}/1M</span>}
                            {m.outputPricePerMTok != null && <span>out ${m.outputPricePerMTok}/1M</span>}
                            {m.pricePerImage != null && <span>${m.pricePerImage}/image</span>}
                            {m.pricePerSecond != null && <span>${m.pricePerSecond}/second</span>}
                            {m.lastTestedAt && <span>tested {formatRelative(m.lastTestedAt)}</span>}
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
                              // The test is a chat request, which an image / video model cannot answer.
                              // Creative Studio offers it only on a provider that can generate media.
                              mediaProviders.has(m.providerId) && (
                                <Link href="/dashboard/studio" className="btn-ghost" title="Try this model in Creative Studio">
                                  <Icon name="studio" /> Try
                                </Link>
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
