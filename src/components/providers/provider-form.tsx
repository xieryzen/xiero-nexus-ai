"use client";

import { useState } from "react";
import { ANTHROPIC_DEFAULT_API_VERSION } from "@/lib/adapters/anthropic-protocol";
import { CUSTOM_HTTP_EXAMPLE, MAX_CUSTOM_CONFIG_CHARS } from "@/lib/adapters/custom-http-protocol";
import {
  MEDIA_API_LABELS,
  MEDIA_API_SETTINGS,
  detectMediaApi,
  type MediaApiSetting,
} from "@/lib/adapters/media-protocol";
import type { ProviderDTO } from "@/lib/providers";
import { apiFetch, ApiError } from "@/lib/client";
import { Alert, Button, Field, Input, Select, Textarea } from "@/components/ui";

// Mirrors the server-side registry in src/lib/adapters/index.ts.
const ADAPTERS = [
  { value: "openai-compatible", label: "OpenAI-compatible" },
  { value: "anthropic", label: "Anthropic" },
  { value: "gemini", label: "Google Gemini" },
  { value: "custom-http", label: "Custom HTTP (any JSON API)" },
] as const;

type AdapterId = (typeof ADAPTERS)[number]["value"];

interface Hints {
  baseUrl: string;
  baseUrlPlaceholder: string;
  /** Filled in for a new provider when the adapter is chosen. */
  baseUrlDefault?: string;
  keyPlaceholder: string;
  /** Null: this adapter has no API version setting. */
  apiVersion: string | null;
  apiVersionPlaceholder: string;
}

const HINTS: Record<AdapterId, Hints> = {
  "openai-compatible": {
    baseUrl: "OpenAI-compatible root, often ending in /v1.",
    baseUrlPlaceholder: "https://api.example.com/v1",
    keyPlaceholder: "sk-…",
    apiVersion: "Optional",
    apiVersionPlaceholder: "optional",
  },
  anthropic: {
    baseUrl: "Anthropic API root, ending in /v1.",
    baseUrlPlaceholder: "https://api.anthropic.com/v1",
    baseUrlDefault: "https://api.anthropic.com/v1",
    keyPlaceholder: "sk-ant-…",
    apiVersion: `anthropic-version header. Blank = ${ANTHROPIC_DEFAULT_API_VERSION}.`,
    apiVersionPlaceholder: ANTHROPIC_DEFAULT_API_VERSION,
  },
  gemini: {
    baseUrl: "Gemini API root with its version (Google AI Studio keys).",
    baseUrlPlaceholder: "https://generativelanguage.googleapis.com/v1beta",
    baseUrlDefault: "https://generativelanguage.googleapis.com/v1beta",
    keyPlaceholder: "AIza…",
    apiVersion: null,
    apiVersionPlaceholder: "",
  },
  "custom-http": {
    baseUrl: "The root of the API. The paths in the configuration are added to it.",
    baseUrlPlaceholder: "https://llm.example.com",
    keyPlaceholder: "the API's key or token",
    apiVersion: null,
    apiVersionPlaceholder: "",
  },
};

const DEFAULT_BASE_URLS = new Set(
  Object.values(HINTS)
    .map((h) => h.baseUrlDefault)
    .filter(Boolean),
);

const EXAMPLE_CONFIG = JSON.stringify(CUSTOM_HTTP_EXAMPLE, null, 2);

export function ProviderForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial?: ProviderDTO;
  onSaved: (p: ProviderDTO) => void;
  onCancel: () => void;
}) {
  const editing = Boolean(initial);
  const [name, setName] = useState(initial?.name ?? "");
  const [adapter, setAdapter] = useState(initial?.adapter ?? "openai-compatible");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [authType, setAuthType] = useState(initial?.authType ?? "bearer");
  const [authHeaderName, setAuthHeaderName] = useState(initial?.authHeaderName ?? "");
  const [apiKey, setApiKey] = useState("");
  const [apiVersion, setApiVersion] = useState(initial?.apiVersion ?? "");
  const [mediaApi, setMediaApi] = useState<MediaApiSetting>(initial?.mediaApi ?? "auto");
  const [config, setConfig] = useState(initial?.config ?? "");
  const [timeoutMs, setTimeoutMs] = useState(String(initial?.timeoutMs ?? 60000));
  const [priority, setPriority] = useState(String(initial?.priority ?? 100));
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const hints = HINTS[adapter as AdapterId] ?? HINTS["openai-compatible"];
  // The request style setting is the OpenAI-compatible adapter's: other
  // adapters have one way to ask for media, or none.
  const supportsMedia = adapter === "openai-compatible";
  const isCustom = adapter === "custom-http";
  const detectedMediaApi = baseUrl.trim() ? MEDIA_API_LABELS[detectMediaApi(baseUrl.trim())] : null;

  function chooseAdapter(next: ProviderDTO["adapter"]) {
    setAdapter(next);
    const nextHints = HINTS[next as AdapterId];
    // A new provider starts from the adapter's own address, unless one was typed.
    if (!editing && (baseUrl.trim() === "" || DEFAULT_BASE_URLS.has(baseUrl.trim()))) {
      setBaseUrl(nextHints?.baseUrlDefault ?? "");
    }
    if (next === "custom-http" && !config.trim()) setConfig(EXAMPLE_CONFIG);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const payload: Record<string, unknown> = {
      name,
      adapter,
      baseUrl,
      authType,
      authHeaderName: authType === "header" ? authHeaderName : undefined,
      // When editing, a cleared field has to be sent to clear the stored value.
      apiVersion: editing ? apiVersion.trim() : apiVersion.trim() || undefined,
      mediaApi: supportsMedia ? mediaApi : undefined,
      config: isCustom ? config : undefined,
      timeoutMs: Number(timeoutMs),
      priority: Number(priority),
      notes: notes || undefined,
    };
    if (apiKey) payload.apiKey = apiKey;

    try {
      const res = editing
        ? await apiFetch<{ provider: ProviderDTO }>(`/api/providers/${initial!.id}`, {
            method: "PATCH",
            body: JSON.stringify(payload),
          })
        : await apiFetch<{ provider: ProviderDTO }>("/api/providers", {
            method: "POST",
            body: JSON.stringify(payload),
          });
      onSaved(res.provider);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save provider");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="p-name">
          <Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Primary OpenAI" />
        </Field>
        <Field label="Adapter" htmlFor="p-adapter">
          <Select id="p-adapter" value={adapter} onChange={(e) => chooseAdapter(e.target.value as ProviderDTO["adapter"])}>
            {ADAPTERS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field label="Base URL" htmlFor="p-baseurl" hint={`${hints.baseUrl} Private/loopback hosts are blocked.`}>
        <Input id="p-baseurl" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required placeholder={hints.baseUrlPlaceholder} className="mono" />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Auth type" htmlFor="p-auth">
          <Select id="p-auth" value={authType} onChange={(e) => setAuthType(e.target.value as ProviderDTO["authType"])}>
            <option value="bearer">Bearer token</option>
            <option value="header">Custom header</option>
            <option value="none">None</option>
          </Select>
        </Field>
        {authType === "header" && (
          <Field label="Header name" htmlFor="p-header">
            <Input id="p-header" value={authHeaderName} onChange={(e) => setAuthHeaderName(e.target.value)} placeholder="x-api-key" className="mono" />
          </Field>
        )}
      </div>
      {adapter === "gemini" && authType !== "none" && (
        <p className="-mt-2 text-xs text-ink-3">
          A Gemini API key is sent in the <span className="mono">x-goog-api-key</span> header, whichever auth type is
          chosen. Only for an OAuth token: choose “Custom header” with the name <span className="mono">authorization</span>.
        </p>
      )}

      {authType !== "none" && (
        <Field
          label="API key"
          htmlFor="p-key"
          hint={editing ? "Leave blank to keep the current key." : "Stored encrypted; never shown again."}
        >
          <Input
            id="p-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={initial?.credential.configured ? `•••••• ${initial.credential.last4 ?? ""}` : hints.keyPlaceholder}
            className="mono"
            autoComplete="off"
          />
        </Field>
      )}

      <div className={hints.apiVersion === null ? "grid gap-4 sm:grid-cols-2" : "grid gap-4 sm:grid-cols-3"}>
        {hints.apiVersion !== null && (
          <Field label="API version" htmlFor="p-ver" hint={hints.apiVersion}>
            <Input id="p-ver" value={apiVersion} onChange={(e) => setApiVersion(e.target.value)} placeholder={hints.apiVersionPlaceholder} />
          </Field>
        )}
        <Field label="Timeout (ms)" htmlFor="p-timeout">
          <Input id="p-timeout" type="number" min={1000} max={300000} value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} />
        </Field>
        <Field label="Priority" htmlFor="p-priority" hint="Lower = higher">
          <Input id="p-priority" type="number" min={1} max={1000} value={priority} onChange={(e) => setPriority(e.target.value)} />
        </Field>
      </div>

      {supportsMedia && (
        <Field
          label="Image / video API"
          htmlFor="p-media-api"
          hint={
            mediaApi === "auto"
              ? `How image and video requests are written. Only matters for image / video models.${detectedMediaApi ? ` For this Base URL: ${detectedMediaApi}.` : ""}`
              : "How image and video requests are written. Only matters for image / video models."
          }
        >
          <Select id="p-media-api" value={mediaApi} onChange={(e) => setMediaApi(e.target.value as MediaApiSetting)}>
            {MEDIA_API_SETTINGS.map((value) => (
              <option key={value} value={value}>
                {MEDIA_API_LABELS[value]}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {isCustom && (
        <Field
          label="Configuration"
          htmlFor="p-config"
          hint={
            "JSON: how a chat request is written and where the answer is in the response. In the body, " +
            "{{model}}, {{messages}}, {{system}}, {{prompt}}, {{last_user_message}}, {{temperature}} and " +
            "{{max_tokens}} are filled in. Paths such as message.content point into the response. " +
            "The README has the details. Answers are not streamed, and agents on such a model have no tools."
          }
        >
          <Textarea
            id="p-config"
            value={config}
            onChange={(e) => setConfig(e.target.value)}
            rows={14}
            maxLength={MAX_CUSTOM_CONFIG_CHARS}
            spellCheck={false}
            className="mono text-xs"
            required
          />
          <button
            type="button"
            className="text-xs text-signal hover:underline"
            onClick={() => setConfig(EXAMPLE_CONFIG)}
          >
            Start from the example (Ollama’s own chat API)
          </button>
        </Field>
      )}

      <Field label="Notes" htmlFor="p-notes">
        <Input id="p-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" />
      </Field>

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={loading}>
          {editing ? "Save changes" : "Add provider"}
        </Button>
      </div>
    </form>
  );
}
