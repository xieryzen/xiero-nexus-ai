"use client";

import { useState } from "react";
import type { ProviderDTO } from "@/lib/providers";
import { apiFetch, ApiError } from "@/lib/client";
import { formatRelative } from "@/lib/format";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  StatusDot,
  cn,
} from "@/components/ui";
import { Icon } from "@/components/icons";
import { ProviderForm } from "./provider-form";
import { DiscoverPanel } from "./discover-panel";

export function ProvidersManager({
  initialProviders,
  modelCounts: initialCounts,
  isAdmin,
}: {
  initialProviders: ProviderDTO[];
  modelCounts: Record<string, number>;
  isAdmin: boolean;
}) {
  const [providers, setProviders] = useState(initialProviders);
  const [counts, setCounts] = useState(initialCounts);
  const [form, setForm] = useState<{ mode: "new" | "edit"; provider?: ProviderDTO } | null>(null);
  const [discoverId, setDiscoverId] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, string | undefined>>({});

  function patchProvider(p: ProviderDTO) {
    setProviders((list) => {
      const idx = list.findIndex((x) => x.id === p.id);
      if (idx === -1) return [p, ...list];
      const next = [...list];
      next[idx] = p;
      return next;
    });
  }

  async function test(p: ProviderDTO) {
    setBusy((b) => ({ ...b, [p.id]: "test" }));
    try {
      const res = await apiFetch<{ ok: boolean; error?: string }>(
        `/api/providers/${p.id}/test`,
        { method: "POST", body: JSON.stringify({}) },
      );
      patchProvider({
        ...p,
        lastTestedAt: new Date(),
        lastTestStatus: res.ok ? "ok" : "error",
        lastTestError: res.ok ? null : res.error ?? "Test failed",
      });
    } catch (err) {
      patchProvider({
        ...p,
        lastTestedAt: new Date(),
        lastTestStatus: "error",
        lastTestError: err instanceof ApiError ? err.message : "Test failed",
      });
    } finally {
      setBusy((b) => ({ ...b, [p.id]: undefined }));
    }
  }

  async function toggleStatus(p: ProviderDTO) {
    setBusy((b) => ({ ...b, [p.id]: "status" }));
    try {
      const next = p.status === "enabled" ? "disabled" : "enabled";
      const res = await apiFetch<{ provider: ProviderDTO }>(`/api/providers/${p.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: next }),
      });
      patchProvider(res.provider);
    } catch {
      /* ignore */
    } finally {
      setBusy((b) => ({ ...b, [p.id]: undefined }));
    }
  }

  async function remove(p: ProviderDTO) {
    if (!confirm(`Delete provider "${p.name}"? Its models will also be removed.`)) return;
    setBusy((b) => ({ ...b, [p.id]: "delete" }));
    try {
      await apiFetch(`/api/providers/${p.id}`, { method: "DELETE" });
      setProviders((list) => list.filter((x) => x.id !== p.id));
    } catch {
      setBusy((b) => ({ ...b, [p.id]: undefined }));
    }
  }

  return (
    <div>
      <PageHeader
        title="Providers"
        description="Connections to AI providers. Credentials are encrypted and never returned to the browser."
        actions={
          isAdmin && !form ? (
            <Button onClick={() => setForm({ mode: "new" })}>
              <Icon name="plus" /> Add provider
            </Button>
          ) : undefined
        }
      />

      {form && (
        <div className="mb-6">
          <Card title={form.mode === "new" ? "New provider" : `Edit ${form.provider?.name}`}>
            <ProviderForm
              initial={form.provider}
              onSaved={(p) => {
                patchProvider(p);
                setForm(null);
              }}
              onCancel={() => setForm(null)}
            />
          </Card>
        </div>
      )}

      {providers.length === 0 ? (
        <EmptyState
          title="No providers yet"
          description="Add your first provider connection to begin building your model catalog."
          action={isAdmin ? <Button onClick={() => setForm({ mode: "new" })}>Add provider</Button> : undefined}
        />
      ) : (
        <div className="space-y-4">
          {providers.map((p) => (
            <Card key={p.id}>
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-ink">{p.name}</h3>
                    <Badge tone={p.status === "enabled" ? "ok" : "neutral"}>
                      <StatusDot tone={p.status === "enabled" ? "ok" : "neutral"} />
                      {p.status}
                    </Badge>
                    <Badge tone={p.adapterImplemented ? "info" : "warn"}>{p.adapter}</Badge>
                  </div>
                  <dl className="mt-3 grid gap-x-8 gap-y-1.5 text-sm sm:grid-cols-2">
                    <div className="flex gap-2">
                      <dt className="text-ink-3">Base URL</dt>
                      <dd className="mono truncate text-ink-2">{p.baseUrl}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="text-ink-3">Auth</dt>
                      <dd className="text-ink-2">
                        {p.authType === "none" ? (
                          "none"
                        ) : p.credential.configured ? (
                          <span className="mono">•••• {p.credential.last4}</span>
                        ) : (
                          <span className="text-warn">no key</span>
                        )}
                      </dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="text-ink-3">Models</dt>
                      <dd className="text-ink-2">{counts[p.id] ?? 0}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="text-ink-3">Last test</dt>
                      <dd>
                        {p.lastTestStatus ? (
                          <span className={p.lastTestStatus === "ok" ? "text-ok" : "text-danger"}>
                            {p.lastTestStatus}
                            {p.lastTestedAt ? ` · ${formatRelative(p.lastTestedAt)}` : ""}
                          </span>
                        ) : (
                          <span className="text-ink-3">never</span>
                        )}
                      </dd>
                    </div>
                  </dl>
                  {p.lastTestStatus === "error" && p.lastTestError && (
                    <p className="mt-2 rounded border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-xs text-danger">
                      {p.lastTestError}
                    </p>
                  )}
                </div>

                {isAdmin && (
                  <div className="flex flex-wrap gap-2 lg:flex-col lg:items-stretch">
                    <Button
                      variant="ghost"
                      loading={busy[p.id] === "test"}
                      disabled={!p.adapterImplemented || !!busy[p.id]}
                      onClick={() => test(p)}
                    >
                      <Icon name="test" /> Test
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={!p.adapterImplemented || !!busy[p.id]}
                      onClick={() => setDiscoverId(discoverId === p.id ? null : p.id)}
                    >
                      <Icon name="refresh" /> Discover
                    </Button>
                    <Button variant="ghost" disabled={!!busy[p.id]} onClick={() => setForm({ mode: "edit", provider: p })}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      loading={busy[p.id] === "status"}
                      disabled={!!busy[p.id]}
                      onClick={() => toggleStatus(p)}
                    >
                      {p.status === "enabled" ? "Disable" : "Enable"}
                    </Button>
                    <Button variant="danger" loading={busy[p.id] === "delete"} disabled={!!busy[p.id]} onClick={() => remove(p)}>
                      <Icon name="trash" /> Delete
                    </Button>
                  </div>
                )}
              </div>

              {discoverId === p.id && (
                <DiscoverPanel
                  provider={p}
                  onImported={(n) => setCounts((c) => ({ ...c, [p.id]: (c[p.id] ?? 0) + n }))}
                  onClose={() => setDiscoverId(null)}
                />
              )}
            </Card>
          ))}
        </div>
      )}

      {!isAdmin && (
        <p className={cn("mt-4 text-xs text-ink-3")}>
          Provider configuration is restricted to administrators.
        </p>
      )}
    </div>
  );
}
