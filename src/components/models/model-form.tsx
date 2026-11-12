"use client";

import { useState } from "react";
import type { SerializedModel } from "@/lib/models";
import { CAPABILITIES, CAPABILITY_LABELS, type Capability } from "@/lib/capabilities";
import { apiFetch, ApiError } from "@/lib/client";
import { Alert, Button, Field, Input, Select, cn } from "@/components/ui";

type ModelType = "chat" | "image" | "video" | "custom";

const TYPE_CAPABILITIES: Record<Exclude<ModelType, "custom">, Capability[]> = {
  chat: ["text", "streaming"],
  image: ["image_generation"],
  video: ["video_generation"],
};

/** The model type the ticked capabilities amount to. */
function typeOf(caps: Set<Capability>): ModelType {
  const image = caps.has("image_generation");
  const video = caps.has("video_generation");
  if (!image && !video) return caps.has("text") ? "chat" : "custom";
  if (caps.has("text") || (image && video)) return "custom";
  return image ? "image" : "video";
}

export function ModelForm({
  providers,
  initial,
  onSaved,
  onCancel,
}: {
  providers: { id: string; name: string; supportsMedia: boolean }[];
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
  const [imagePrice, setImagePrice] = useState(
    initial?.pricePerImage != null ? String(initial.pricePerImage) : "",
  );
  const [secondPrice, setSecondPrice] = useState(
    initial?.pricePerSecond != null ? String(initial.pricePerSecond) : "",
  );
  const [caps, setCaps] = useState<Set<Capability>>(
    new Set(initial?.capabilities.map((c) => c.capability) ?? ["text", "streaming"]),
  );
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const modelType = typeOf(caps);
  const generatesImages = caps.has("image_generation");
  const generatesVideos = caps.has("video_generation");
  const mediaNoun = generatesImages && generatesVideos ? "images and videos" : generatesImages ? "images" : "videos";
  const provider = providers.find((p) => p.id === providerId);

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
    // When editing, an emptied field is sent as null, which clears the stored value.
    const empty = editing ? null : undefined;
    const num = (value: string) => (value.trim() ? Number(value) : empty);
    const common = {
      displayName: displayName.trim() || empty,
      contextWindow: num(contextWindow),
      inputPricePerMTok: num(inputPrice),
      outputPricePerMTok: num(outputPrice),
      // A media price is kept only while the model has that capability.
      pricePerImage: caps.has("image_generation") ? num(imagePrice) : empty,
      pricePerSecond: caps.has("video_generation") ? num(secondPrice) : empty,
      capabilities: [...caps],
      notes: notes.trim() || empty,
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

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Display name" htmlFor="m-name" hint="Optional friendly label">
          <Input id="m-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="optional" />
        </Field>
        <Field label="Model type" htmlFor="m-type" hint="Sets the capabilities below. An image or video model is kept out of chat, agents and routing.">
          <Select
            id="m-type"
            value={modelType}
            onChange={(e) => {
              const next = e.target.value as ModelType;
              if (next !== "custom") setCaps(new Set(TYPE_CAPABILITIES[next]));
            }}
          >
            <option value="chat">Chat / text model</option>
            <option value="image">Image generation model</option>
            <option value="video">Video generation model</option>
            {modelType === "custom" && <option value="custom">Custom (see capabilities)</option>}
          </Select>
        </Field>
      </div>

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

      {(generatesImages || generatesVideos) && (
        <div className="grid gap-4 sm:grid-cols-3">
          {generatesImages && (
            <Field label="Price per image ($)" htmlFor="m-img-price" hint="optional, for cost estimates">
              <Input id="m-img-price" type="number" step="0.0001" min={0} value={imagePrice} onChange={(e) => setImagePrice(e.target.value)} placeholder="0.04" />
            </Field>
          )}
          {generatesVideos && (
            <Field label="Price per second ($)" htmlFor="m-sec-price" hint="of generated video, optional">
              <Input id="m-sec-price" type="number" step="0.0001" min={0} value={secondPrice} onChange={(e) => setSecondPrice(e.target.value)} placeholder="0.10" />
            </Field>
          )}
        </div>
      )}

      {(generatesImages || generatesVideos) && provider && !provider.supportsMedia && (
        <Alert tone="warn">
          {provider.name} cannot generate {mediaNoun}: that needs a provider with the OpenAI-compatible
          adapter. On this provider the model is not offered in Creative Studio or for image and video tasks.
        </Alert>
      )}
      {(generatesImages || generatesVideos) && caps.has("text") && (
        <Alert tone="info">
          Text is ticked too, so this model is also offered for chat, agents and routing. Untick Text if it
          only generates {mediaNoun}.
        </Alert>
      )}

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
