"use client";

import { useState } from "react";
import type { SerializedModel } from "@/lib/models";
import { CAPABILITIES, CAPABILITY_LABELS, type Capability } from "@/lib/capabilities";
import { apiFetch, ApiError } from "@/lib/client";
import { Alert, Button, Field, Input, Select, cn } from "@/components/ui";

export function ModelForm({
  providers,
  initial,
  onSaved,
  onCancel,
}: {
  providers: { id: string; name: string }[];
  initial?: SerializedModel;
  onSaved: (m: SerializedModel) => void;
  onCancel: () => void;
}) {
  const editing = Boolean(initial);
  const [providerId, setProviderId] = useState(initial?.providerId ?? providers[0]?.id ?? "");
  const [modelId, setModelId] = useState(initial?.modelId ?? "");
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  const [contextWindow, setContextWindow] = useState(
    initial?.contextWindow != null ? String(initial.contextWindow) : "",
  );
  const [inputPrice, setInputPrice] = useState(
    initial?.inputPricePerMTok != null ? String(initial.inputPricePerMTok) : "",
  );
  const [outputPrice, setOutputPrice] = useState(
    initial?.outputPricePerMTok != null ? String(initial.outputPricePerMTok) : "",
  );
  const [caps, setCaps] = useState<Set<Capability>>(
    new Set(initial?.capabilities.map((c) => c.capability) ?? ["text", "streaming"]),
  );
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function toggleCap(c: Capability) {
    setCaps((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const common = {
      displayName: displayName || undefined,
      contextWindow: contextWindow ? Number(contextWindow) : undefined,
      inputPricePerMTok: inputPrice ? Number(inputPrice) : undefined,
      outputPricePerMTok: outputPrice ? Number(outputPrice) : undefined,
      capabilities: [...caps],
      notes: notes || undefined,
    };
    try {
      const res = editing
        ? await apiFetch<{ model: SerializedModel }>(`/api/models/${initial!.id}`, {
            method: "PATCH",
            body: JSON.stringify(common),
          })
        : await apiFetch<{ model: SerializedModel }>("/api/models", {
            method: "POST",
            body: JSON.stringify({ providerId, modelId, ...common }),
          });
      onSaved(res.model);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save model");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Provider" htmlFor="m-provider">
          <Select
            id="m-provider"
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            disabled={editing}
            required
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Model ID" htmlFor="m-id" hint="Upstream id, exactly as the provider expects">
          <Input
            id="m-id"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            disabled={editing}
            required
            placeholder="gpt-4o-mini"
            className="mono"
          />
        </Field>
      </div>

      <Field label="Display name" htmlFor="m-name" hint="Optional friendly label">
        <Input id="m-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="optional" />
      </Field>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Context window" htmlFor="m-ctx" hint="tokens, optional">
          <Input id="m-ctx" type="number" min={1} value={contextWindow} onChange={(e) => setContextWindow(e.target.value)} placeholder="128000" />
        </Field>
        <Field label="Input $/1M" htmlFor="m-in" hint="optional">
          <Input id="m-in" type="number" step="0.0001" min={0} value={inputPrice} onChange={(e) => setInputPrice(e.target.value)} placeholder="0.15" />
        </Field>
        <Field label="Output $/1M" htmlFor="m-out" hint="optional">
          <Input id="m-out" type="number" step="0.0001" min={0} value={outputPrice} onChange={(e) => setOutputPrice(e.target.value)} placeholder="0.60" />
        </Field>
      </div>

      <Field label="Capabilities" hint="Mark only what the provider documents or you have verified.">
        <div className="flex flex-wrap gap-2">
          {CAPABILITIES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => toggleCap(c)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition",
                caps.has(c)
                  ? "border-signal/50 bg-signal/15 text-signal"
                  : "border-line text-ink-2 hover:text-ink",
              )}
            >
              {CAPABILITY_LABELS[c]}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Notes" htmlFor="m-notes">
        <Input id="m-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" />
      </Field>

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={loading}>
          {editing ? "Save changes" : "Add model"}
        </Button>
      </div>
    </form>
  );
}
