"use client";

import { useEffect, useState } from "react";
import type { ProviderDTO } from "@/lib/providers";
import { apiFetch, ApiError } from "@/lib/client";
import { Alert, Button, Spinner, cn } from "@/components/ui";

interface DiscoverResult {
  ok: boolean;
  models?: string[];
  existing?: string[];
  error?: string;
}

export function DiscoverPanel({
  provider,
  onImported,
  onClose,
}: {
  provider: ProviderDTO;
  onImported: (count: number) => void;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState<string[]>([]);
  const [existing, setExisting] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await apiFetch<DiscoverResult>(
          `/api/providers/${provider.id}/models/discover`,
          { method: "POST", body: JSON.stringify({}) },
        );
        if (!active) return;
        if (!res.ok) {
          setError(res.error ?? "Discovery failed");
        } else {
          setAvailable(res.models ?? []);
          setExisting(new Set(res.existing ?? []));
        }
      } catch (err) {
        if (active) setError(err instanceof ApiError ? err.message : "Discovery failed");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [provider.id]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function importSelected() {
    if (selected.size === 0) return;
    setImporting(true);
    setError(null);
    try {
      const res = await apiFetch<DiscoverResult & { imported: number }>(
        `/api/providers/${provider.id}/models/discover`,
        { method: "POST", body: JSON.stringify({ import: [...selected] }) },
      );
      onImported(res.imported ?? 0);
      setExisting((prev) => new Set([...prev, ...selected]));
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Import failed");
    } finally {
      setImporting(false);
    }
  }

  const importable = available.filter((m) => !existing.has(m));

  return (
    <div className="mt-4 rounded-md border border-line bg-surface-2/50 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">Discover models</h3>
        <button onClick={onClose} className="text-xs text-ink-3 hover:text-ink">
          Close
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-ink-2">
          <Spinner /> Querying provider…
        </div>
      ) : error ? (
        <Alert tone="danger">{error}</Alert>
      ) : available.length === 0 ? (
        <p className="py-4 text-sm text-ink-2">No models returned by this provider.</p>
      ) : (
        <>
          <div className="max-h-64 overflow-y-auto rounded border border-line">
            <ul className="divide-y divide-line">
              {available.map((m) => {
                const already = existing.has(m);
                return (
                  <li key={m}>
                    <label
                      className={cn(
                        "flex cursor-pointer items-center gap-3 px-3 py-2 text-sm",
                        already && "opacity-50",
                      )}
                    >
                      <input
                        type="checkbox"
                        className="accent-signal"
                        disabled={already}
                        checked={already || selected.has(m)}
                        onChange={() => toggle(m)}
                      />
                      <span className="mono text-ink">{m}</span>
                      {already && <span className="ml-auto text-xs text-ink-3">in catalog</span>}
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="mt-3 flex items-center justify-between">
            <p className="text-xs text-ink-3">
              {importable.length} new · {selected.size} selected
            </p>
            <Button onClick={importSelected} loading={importing} disabled={selected.size === 0}>
              Import selected
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
