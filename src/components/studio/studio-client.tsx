"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ASPECT_RATIOS,
  MAX_IMAGES_PER_REQUEST,
  MAX_MEDIA_PROMPT_CHARS,
  MAX_VIDEO_SECONDS,
  type MediaApi,
} from "@/lib/adapters/media-protocol";
import type { MediaAssetDTO } from "@/lib/media/dto";
import { apiFetch, ApiError, copyText } from "@/lib/client";
import { formatBytes, formatCost, formatRelative } from "@/lib/format";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
  cn,
} from "@/components/ui";
import { Icon } from "@/components/icons";
import { MediaView } from "@/components/media/media-view";
import { useMediaPolling } from "@/components/media/use-media-polling";

export interface StudioModel {
  id: string;
  label: string;
  /** The request style of its provider, which decides the options it takes. */
  mediaApi: MediaApi;
  /** Per image, or per second of video. Null when no price is set. */
  price: number | null;
}

type Kind = "image" | "video";
type Filter = "all" | Kind;

interface Page {
  assets: MediaAssetDTO[];
  nextOffset: number | null;
}

const RESOLUTION_HINTS: Record<Kind, Record<MediaApi, string[]>> = {
  image: { openai: [], openrouter: ["1K", "2K", "4K"], xai: ["1k", "2k"] },
  video: {
    openai: ["480p", "720p", "1080p"],
    openrouter: ["480p", "720p", "1080p"],
    xai: ["480p", "720p", "1080p"],
  },
};

function optionSummary(asset: MediaAssetDTO): string {
  return [
    asset.options.aspectRatio,
    asset.kind === "video" && (asset.durationSeconds ?? asset.options.durationSeconds)
      ? `${asset.durationSeconds ?? asset.options.durationSeconds}s`
      : null,
    asset.options.resolution,
    asset.options.size,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function StudioClient({
  imageModels,
  videoModels,
  initialAssets,
  initialNextOffset,
  isAdmin,
  project,
}: {
  imageModels: StudioModel[];
  videoModels: StudioModel[];
  initialAssets: MediaAssetDTO[];
  initialNextOffset: number | null;
  isAdmin: boolean;
  /** Set when the page shows what one project's runs produced. */
  project: { id: string; title: string } | null;
}) {
  // ── Library ────────────────────────────────────────────────────────────────
  const [assets, setAssets] = useState(initialAssets);
  const [nextOffset, setNextOffset] = useState(initialNextOffset);
  const [filter, setFilter] = useState<Filter>("all");
  const [everyone, setEveryone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [checkErrors, setCheckErrors] = useState<Record<string, string | undefined>>({});
  const [copied, setCopied] = useState<{ id: string; ok: boolean } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  async function load(next: { filter?: Filter; everyone?: boolean; offset?: number } = {}) {
    const f = next.filter ?? filter;
    const all = next.everyone ?? everyone;
    const offset = next.offset ?? 0;
    const query = new URLSearchParams();
    if (f !== "all") query.set("kind", f);
    if (project) query.set("projectId", project.id);
    else if (all) query.set("scope", "all");
    if (offset > 0) query.set("offset", String(offset));
    setLoading(true);
    setLibraryError(null);
    try {
      const page = await apiFetch<Page>(`/api/media?${query.toString()}`);
      setAssets((prev) => {
        if (offset === 0) return page.assets;
        const seen = new Set(prev.map((a) => a.id));
        return [...prev, ...page.assets.filter((a) => !seen.has(a.id))];
      });
      setNextOffset(page.nextOffset);
      setFilter(f);
      setEveryone(all);
    } catch (err) {
      setLibraryError(err instanceof ApiError ? err.message : "Could not load the library");
    } finally {
      setLoading(false);
    }
  }

  function replace(asset: MediaAssetDTO) {
    // The refresh answer has no owner name: keep the one already shown.
    setAssets((list) => list.map((a) => (a.id === asset.id ? { ...asset, owner: a.owner } : a)));
  }

  useMediaPolling(
    assets.filter((a) => a.status === "pending").map((a) => a.id),
    {
      onUpdate: (asset, checkError) => {
        replace(asset);
        setCheckErrors((e) => ({ ...e, [asset.id]: checkError ?? undefined }));
      },
      onGone: (id) => setAssets((list) => list.filter((a) => a.id !== id)),
    },
  );

  async function remove(asset: MediaAssetDTO) {
    const what =
      asset.status === "pending"
        ? "Stop waiting for this video and remove it? The provider may still charge for it."
        : `Delete this ${asset.kind}? The file is removed from the server.`;
    if (!confirm(what)) return;
    setDeleting(asset.id);
    try {
      await apiFetch(`/api/media/${asset.id}`, { method: "DELETE" });
      setAssets((list) => list.filter((a) => a.id !== asset.id));
    } catch (err) {
      setLibraryError(err instanceof ApiError ? err.message : "Could not delete");
    } finally {
      setDeleting(null);
    }
  }

  async function copyPrompt(asset: MediaAssetDTO) {
    const ok = await copyText(asset.prompt);
    setCopied({ id: asset.id, ok });
    setTimeout(() => setCopied((c) => (c?.id === asset.id ? null : c)), 1500);
  }

  // ── Form ───────────────────────────────────────────────────────────────────
  const [kind, setKind] = useState<Kind>(imageModels.length === 0 && videoModels.length > 0 ? "video" : "image");
  const [modelIds, setModelIds] = useState<Record<Kind, string>>({
    image: imageModels[0]?.id ?? "",
    video: videoModels[0]?.id ?? "",
  });
  const [prompt, setPrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState("");
  const [count, setCount] = useState("1");
  const [duration, setDuration] = useState("8");
  const [resolution, setResolution] = useState("");
  const [size, setSize] = useState("");
  const [extraText, setExtraText] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const models = kind === "image" ? imageModels : videoModels;
  const model = models.find((m) => m.id === modelIds[kind]) ?? models[0] ?? null;
  const api: MediaApi = model?.mediaApi ?? "openai";
  const resolutionHints = RESOLUTION_HINTS[kind][api];
  // Each style takes its own sizing options; the others would be ignored.
  const showResolution = !(kind === "image" && api === "openai");
  const showSize = api !== "xai";
  const hasAnyModel = imageModels.length > 0 || videoModels.length > 0;

  const units = kind === "image" ? Number(count) || 1 : Number(duration) || 0;
  const estimate = model?.price != null && units > 0 ? model.price * units : null;

  function reuse(asset: MediaAssetDTO) {
    const list = asset.kind === "image" ? imageModels : videoModels;
    setKind(asset.kind);
    if (asset.modelRowId && list.some((m) => m.id === asset.modelRowId)) {
      setModelIds((ids) => ({ ...ids, [asset.kind]: asset.modelRowId! }));
    }
    setPrompt(asset.prompt);
    setAspectRatio(asset.options.aspectRatio ?? "");
    setResolution(asset.options.resolution ?? "");
    setSize(asset.options.size ?? "");
    if (asset.kind === "video") {
      setDuration(asset.options.durationSeconds ? String(asset.options.durationSeconds) : "");
    }
    if (asset.options.size) setShowAdvanced(true);
    setFormError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    if (!model) return;
    setFormError(null);

    let extra: Record<string, unknown> | undefined;
    if (extraText.trim()) {
      try {
        const parsed: unknown = JSON.parse(extraText);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("shape");
        extra = parsed as Record<string, unknown>;
      } catch {
        setFormError('Extra parameters must be a JSON object, for example {"quality": "high"}.');
        return;
      }
    }
    const common = {
      modelRowId: model.id,
      prompt: prompt.trim(),
      aspectRatio: aspectRatio || undefined,
      resolution: showResolution && resolution.trim() ? resolution.trim() : undefined,
      size: showSize && size.trim() ? size.trim() : undefined,
      extra,
    };

    setBusy(true);
    try {
      let added: MediaAssetDTO[];
      if (kind === "image") {
        const res = await apiFetch<{ assets: MediaAssetDTO[] }>("/api/media/images", {
          method: "POST",
          body: JSON.stringify({ ...common, n: Number(count) || 1 }),
        });
        added = res.assets;
      } else {
        const res = await apiFetch<{ asset: MediaAssetDTO }>("/api/media/videos", {
          method: "POST",
          body: JSON.stringify({ ...common, durationSeconds: duration ? Number(duration) : undefined }),
        });
        added = [res.asset];
      }
      if (everyone || (filter !== "all" && filter !== kind)) {
        // The new media would not be in the list as filtered: show the user's own.
        await load({ filter: "all", everyone: false });
      } else {
        setAssets((list) => [...added, ...list]);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status !== 504) {
        setFormError(err.message);
      } else {
        setFormError(
          "The connection ended before the provider answered. If the media was generated anyway, it shows up after Refresh.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  const pendingCount = assets.filter((a) => a.status === "pending").length;

  return (
    <div>
      <PageHeader
        title="Creative Studio"
        description={
          project
            ? `Images and videos generated by the project "${project.title}".`
            : "Generate images and videos through the gateway. Everything you generate is kept in your library."
        }
        actions={
          project ? (
            <Link href="/dashboard/studio" className="btn-ghost">
              Show all my media
            </Link>
          ) : undefined
        }
      />

      {!project && !hasAnyModel && (
        <div className="mb-6">
          <Alert tone="warn">
            No model is set up for image or video generation yet.{" "}
            {isAdmin ? (
              <>
                On the <Link href="/dashboard/models" className="underline">Models</Link> page, add the image or video
                model of a provider that uses the OpenAI-compatible adapter and tick{" "}
                <strong>Image generation</strong> or <strong>Video generation</strong>.
              </>
            ) : (
              "Ask an administrator to add one on the Models page."
            )}
          </Alert>
        </div>
      )}

      {!project && hasAnyModel && (
        <div className="mb-6">
          <Card>
            <form onSubmit={generate} className="space-y-4">
              <div className="inline-flex rounded-md border border-line p-0.5" role="tablist" aria-label="What to generate">
                {(["image", "video"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    aria-selected={kind === k}
                    onClick={() => {
                      setKind(k);
                      setFormError(null);
                    }}
                    className={cn(
                      "flex items-center gap-2 rounded px-3 py-1.5 text-sm transition",
                      kind === k ? "bg-surface-2 font-medium text-ink" : "text-ink-2 hover:text-ink",
                    )}
                  >
                    <Icon name={k} size={16} /> {k === "image" ? "Image" : "Video"}
                  </button>
                ))}
              </div>

              {models.length === 0 ? (
                <Alert tone="warn">
                  No model is marked for {kind} generation yet.{" "}
                  {isAdmin ? "Add the capability to a model on the Models page." : "Ask an administrator to add one."}
                </Alert>
              ) : (
                <>
                  {formError && <Alert tone="danger">{formError}</Alert>}

                  <Field label="Prompt" htmlFor="st-prompt" hint={`${prompt.length} / ${MAX_MEDIA_PROMPT_CHARS}`}>
                    <Textarea
                      id="st-prompt"
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      required
                      maxLength={MAX_MEDIA_PROMPT_CHARS}
                      className="min-h-[110px]"
                      placeholder={
                        kind === "image"
                          ? "A lighthouse on a cliff at dusk, long exposure, soft orange light…"
                          : "Slow push-in on a lighthouse at dusk, waves breaking below, gulls crossing the frame…"
                      }
                    />
                  </Field>

                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <Field label="Model" htmlFor="st-model">
                      <Select
                        id="st-model"
                        value={model?.id ?? ""}
                        onChange={(e) => setModelIds((ids) => ({ ...ids, [kind]: e.target.value }))}
                      >
                        {models.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field
                      label="Aspect ratio"
                      htmlFor="st-ratio"
                      hint={kind === "image" && api === "openai" ? "Sent as a square, portrait or landscape size." : undefined}
                    >
                      <Select id="st-ratio" value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)}>
                        <option value="">Provider default</option>
                        {ASPECT_RATIOS.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    {kind === "image" ? (
                      <Field label="Images" htmlFor="st-count">
                        <Select id="st-count" value={count} onChange={(e) => setCount(e.target.value)}>
                          {Array.from({ length: MAX_IMAGES_PER_REQUEST }, (_, i) => String(i + 1)).map((n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    ) : (
                      <Field label="Length (seconds)" htmlFor="st-duration" hint="Empty: the provider's default.">
                        <Input
                          id="st-duration"
                          type="number"
                          min={1}
                          max={MAX_VIDEO_SECONDS}
                          step={1}
                          value={duration}
                          onChange={(e) => setDuration(e.target.value)}
                        />
                      </Field>
                    )}
                    {showResolution && (
                      <Field label="Resolution" htmlFor="st-res" hint="Empty: the provider's default.">
                        <Input
                          id="st-res"
                          value={resolution}
                          onChange={(e) => setResolution(e.target.value)}
                          list="st-res-hints"
                          placeholder={resolutionHints[0] ?? ""}
                          maxLength={8}
                        />
                        <datalist id="st-res-hints">
                          {resolutionHints.map((r) => (
                            <option key={r} value={r} />
                          ))}
                        </datalist>
                      </Field>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => setShowAdvanced((s) => !s)}
                    className="text-xs font-medium text-signal hover:underline"
                  >
                    {showAdvanced ? "Hide" : "Show"} advanced options (exact size, extra parameters)
                  </button>
                  {showAdvanced && (
                    <div className="grid gap-4 rounded-md border border-line bg-surface-2/40 p-4 sm:grid-cols-2">
                      {showSize && (
                        <Field
                          label="Exact size"
                          htmlFor="st-size"
                          hint="WIDTHxHEIGHT. Replaces the aspect ratio and resolution."
                        >
                          <Input
                            id="st-size"
                            value={size}
                            onChange={(e) => setSize(e.target.value)}
                            placeholder={kind === "image" ? "1024x1536" : "720x1280"}
                            pattern="auto|\d{2,5}x\d{2,5}"
                          />
                        </Field>
                      )}
                      <Field
                        label="Extra parameters"
                        htmlFor="st-extra"
                        hint="A JSON object added to the request as it is, for options only this provider has."
                      >
                        <Textarea
                          id="st-extra"
                          value={extraText}
                          onChange={(e) => setExtraText(e.target.value)}
                          className="mono min-h-[70px] text-xs"
                          placeholder='{"quality": "high"}'
                          spellCheck={false}
                        />
                      </Field>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs text-ink-3">
                      {estimate != null
                        ? `Estimated cost ${formatCost(estimate)} (${units} ${kind === "image" ? (units === 1 ? "image" : "images") : "s"} × ${formatCost(model?.price)}), from the price set on the model.`
                        : model?.price == null
                          ? `No ${kind === "image" ? "per-image" : "per-second"} price is set on this model, so no estimate. The provider still bills it.`
                          : "The provider bills each generation."}
                    </p>
                    <Button type="submit" loading={busy} disabled={!prompt.trim()}>
                      <Icon name="studio" size={16} /> {busy ? "Generating…" : kind === "image" ? "Generate" : "Start video"}
                    </Button>
                  </div>
                  {busy && kind === "image" && (
                    <p className="text-xs text-ink-3">Waiting for the provider. An image usually takes 10 to 60 seconds.</p>
                  )}
                </>
              )}
            </form>
          </Card>
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-2 text-xs font-semibold uppercase tracking-wider text-ink-3">Library</h2>
          {(["all", "image", "video"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => void load({ filter: f })}
              aria-pressed={filter === f}
              className={cn(
                "rounded-full border px-3 py-1 text-xs transition",
                filter === f ? "border-signal/50 text-signal" : "border-line text-ink-2 hover:text-ink",
              )}
            >
              {f === "all" ? "All" : f === "image" ? "Images" : "Videos"}
            </button>
          ))}
          {isAdmin && !project && (
            <button
              type="button"
              onClick={() => void load({ everyone: !everyone })}
              aria-pressed={everyone}
              className={cn(
                "rounded-full border px-3 py-1 text-xs transition",
                everyone ? "border-signal/50 text-signal" : "border-line text-ink-2 hover:text-ink",
              )}
              title="Administrators can see what every user generated"
            >
              Everyone&apos;s
            </button>
          )}
        </div>
        <div className="flex items-center gap-3">
          {pendingCount > 0 && (
            <span className="text-xs text-ink-3">
              {pendingCount} in progress · keep this page open
            </span>
          )}
          <Button variant="ghost" onClick={() => void load()} loading={loading}>
            <Icon name="refresh" size={16} /> Refresh
          </Button>
        </div>
      </div>

      {libraryError && (
        <div className="mb-3">
          <Alert tone="danger">{libraryError}</Alert>
        </div>
      )}

      {assets.length === 0 ? (
        <EmptyState
          title={loading ? "Loading…" : "Nothing here yet"}
          description={
            project
              ? "This project has not generated any media."
              : "Images and videos you generate, here or in a project, are listed here."
          }
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {assets.map((asset) => {
            const summary = optionSummary(asset);
            return (
              <li key={asset.id} className="card flex flex-col p-3">
                <MediaView asset={asset} />
                <div className="mt-3 flex flex-1 flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
                    <Badge tone={asset.kind === "video" ? "info" : "neutral"}>{asset.kind}</Badge>
                    {asset.status === "pending" && <Badge tone="warn">in progress</Badge>}
                    {asset.status === "failed" && <Badge tone="danger">failed</Badge>}
                    <span className="truncate" title={asset.modelLabel}>
                      {asset.modelLabel}
                    </span>
                    {asset.owner !== undefined && <span>· by {asset.owner ?? "a deleted user"}</span>}
                  </div>
                  <p className="line-clamp-3 text-sm text-ink-2" title={asset.prompt}>
                    {asset.prompt}
                  </p>
                  {asset.status === "failed" && asset.error && (
                    <p className="rounded border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-xs text-danger">
                      {asset.error}
                    </p>
                  )}
                  {asset.status === "pending" && checkErrors[asset.id] && (
                    <p className="rounded border border-warn/30 bg-warn/10 px-2.5 py-1.5 text-xs text-warn">
                      Could not check on it just now: {checkErrors[asset.id]} Trying again.
                    </p>
                  )}
                  <p className="text-xs text-ink-3">
                    {[
                      summary,
                      asset.sizeBytes != null ? formatBytes(asset.sizeBytes) : null,
                      asset.estimatedCost != null ? `est. ${formatCost(asset.estimatedCost)}` : null,
                      formatRelative(asset.createdAt),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  <div className="mt-auto flex flex-wrap items-center gap-1 pt-1">
                    {asset.url && (
                      <a href={`${asset.url}?download=1`} className="btn-ghost px-2 py-1 text-xs" download>
                        <Icon name="download" size={14} /> Download
                      </a>
                    )}
                    <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => void copyPrompt(asset)}>
                      <Icon name={copied?.id === asset.id && copied.ok ? "check" : "copy"} size={14} />{" "}
                      <span aria-live="polite">
                        {copied?.id !== asset.id ? "Copy prompt" : copied.ok ? "Copied" : "Could not copy"}
                      </span>
                    </button>
                    {!project && hasAnyModel && (
                      <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => reuse(asset)}>
                        <Icon name="refresh" size={14} /> Use again
                      </button>
                    )}
                    {asset.projectId && !project && (
                      <Link href={`/dashboard/projects/${asset.projectId}`} className="btn-ghost px-2 py-1 text-xs">
                        <Icon name="manager" size={14} /> Project
                      </Link>
                    )}
                    <button
                      type="button"
                      className="btn-ghost ml-auto px-2 py-1 text-xs text-danger"
                      onClick={() => void remove(asset)}
                      disabled={deleting === asset.id}
                      aria-label={`Delete this ${asset.kind}`}
                    >
                      <Icon name="trash" size={14} /> Delete
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {nextOffset != null && (
        <div className="mt-5 flex justify-center">
          <Button variant="ghost" onClick={() => void load({ offset: nextOffset })} loading={loading}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
