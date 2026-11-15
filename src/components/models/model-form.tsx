"use client";

import { useState } from "react";
import type { SerializedModel } from "@/lib/models";
import { CAPABILITIES, CAPABILITY_LABELS, type Capability } from "@/lib/capabilities";
import { apiFetch, ApiError } from "@/lib/client";
import { Alert, Button, Field, Input, Select, cn } from "@/components/ui";

type ModelType = "chat" | "image" | "video" | "speech" | "embedding" | "custom";

const TYPE_CAPABILITIES: Record<Exclude<ModelType, "custom">, Capability[]> = {
  chat: ["text", "streaming"],
  image: ["image_generation"],
  video: ["video_generation"],
  speech: ["speech_generation"],
  embedding: ["embeddings"],
};

/** The capabilities that make a model something other than a chat model. */
const SPECIAL: [Capability, Exclude<ModelType, "custom" | "chat">][] = [
  ["image_generation", "image"],
  ["video_generation", "video"],
  ["speech_generation", "speech"],
  ["embeddings", "embedding"],
];

/** The model type the ticked capabilities amount to. */
function typeOf(caps: Set<Capability>): ModelType {
  const special = SPECIAL.filter(([cap]) => caps.has(cap));
  if (special.length === 0) return caps.has("text") ? "chat" : "custom";
  if (caps.has("text") || special.length > 1) return "custom";
  return special[0]![1];
}

interface ProviderAbilities {
  image: boolean;
  video: boolean;
  audio: boolean;
  embed: boolean;
  tools: boolean;
}

export function ModelForm({
  providers,
  initial,
  onSaved,
  onCancel,
}: {
  providers: { id: string; name: string; supportsMedia: boolean; abilities: ProviderAbilities }[];
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
  const [charsPrice, setCharsPrice] = useState(
    initial?.pricePerMChars != null ? String(initial.pricePerMChars) : "",
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
  const generatesSpeech = caps.has("speech_generation");
  const embeds = caps.has("embeddings");
  const provider = providers.find((p) => p.id === providerId);
  // What is ticked that this provider's adapter has no API for.
  const unsupported = provider
    ? [
        generatesImages && !provider.abilities.image ? "generate images" : "",
        generatesVideos && !provider.abilities.video ? "generate videos" : "",
        generatesSpeech && !provider.abilities.audio ? "generate speech" : "",
        embeds && !provider.abilities.embed ? "make embeddings" : "",
        caps.has("tool_calling") && !provider.abilities.tools ? "call tools" : "",
      ].filter(Boolean)
    : [];
  const special = [
    generatesImages ? "images" : "",
    generatesVideos ? "videos" : "",
    generatesSpeech ? "speech" : "",
    embeds ? "embeddings" : "",
  ].filter(Boolean);

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
      pricePerMChars: caps.has("speech_generation") ? num(charsPrice) : empty,
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
        <Field label="Model type" htmlFor="m-type" hint="Sets the capabilities below. Only a chat model is offered in chat, to agents and for routing.">
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
            <option value="speech">Speech model (text to speech)</option>
            <option value="embedding">Embedding model</option>
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

      {(generatesImages || generatesVideos || generatesSpeech) && (
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
          {generatesSpeech && (
            <Field label="Price per 1M characters ($)" htmlFor="m-chars-price" hint="of spoken text, optional">
              <Input id="m-chars-price" type="number" step="0.0001" min={0} value={charsPrice} onChange={(e) => setCharsPrice(e.target.value)} placeholder="15" />
            </Field>
          )}
        </div>
      )}

      {unsupported.length > 0 && provider && (
        <Alert tone="warn">
          The adapter of {provider.name} cannot {unsupported.join(" or ")}. The capability can be ticked, but
          the model will not be offered for it until it is on a provider whose adapter can.
        </Alert>
      )}
      {special.length > 0 && caps.has("text") && (
        <Alert tone="info">
          Text is ticked too, so this model is also offered for chat, agents and routing. Untick Text if it
          only does {special.join(" and ")}.
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
