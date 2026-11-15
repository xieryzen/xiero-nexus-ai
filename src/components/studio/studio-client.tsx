"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import {
  ASPECT_RATIOS,
  MAX_IMAGES_PER_REQUEST,
  MAX_MEDIA_PROMPT_CHARS,
  MAX_VIDEO_SECONDS,
  type MediaApi,
} from "@/lib/adapters/media-protocol";
import { MAX_SPEECH_CHARS, MAX_SPEECH_SPEED, MIN_SPEECH_SPEED } from "@/lib/creative/prompt";
import type { MediaAssetDTO } from "@/lib/media/dto";
import { MAX_RENDER_CLIPS } from "@/lib/media/render-plan";
import { apiFetch, apiUpload, ApiError, copyText } from "@/lib/client";
import { formatBytes, formatCost, formatNumber } from "@/lib/format";
import { Dotted, RelativeTime } from "@/components/time";
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
  /** Per image, per second of video, or per million characters of speech. Null when no price is set. */
  price: number | null;
}

/** Whether this server can join clips into one video by itself (it has ffmpeg). */
export interface RenderSupport {
  available: boolean;
  subtitles: boolean;
}

type Kind = "image" | "video" | "audio";
/** What the form does: generate one of the kinds, or join clips that exist. */
type Tab = Kind | "join";
type Filter = "all" | Kind;

interface Page {
  assets: MediaAssetDTO[];
  nextOffset: number | null;
}

const TAB_LABEL: Record<Tab, string> = { image: "Image", video: "Video", audio: "Voice", join: "Join clips" };
const TAB_ICON = { image: "image", video: "video", audio: "audio", join: "render" } as const;
const KIND_NOUN: Record<Kind, string> = { image: "image", video: "video", audio: "voice-over" };

const RESOLUTION_HINTS: Record<"image" | "video", Record<MediaApi, string[]>> = {
  image: { openai: [], openrouter: ["1K", "2K", "4K"], xai: ["1k", "2k"] },
  video: {
    openai: ["480p", "720p", "1080p"],
    openrouter: ["480p", "720p", "1080p"],
    xai: ["480p", "720p", "1080p"],
  },
};

/** Voices that the common speech APIs know. Any other name can be typed. */
const VOICE_HINTS = ["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "Kore", "Puck", "Aoede", "Charon"];

function optionSummary(asset: MediaAssetDTO): string {
  const seconds = asset.durationSeconds ?? asset.options.durationSeconds;
  return [
    asset.options.aspectRatio,
    asset.kind !== "image" && seconds ? `${Math.round(seconds * 10) / 10}s` : null,
    asset.options.resolution,
    asset.options.size,
    asset.options.voice ? `voice ${asset.options.voice}` : null,
    asset.options.imageAssetId ? "from an image" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** What a library card calls the asset. */
function assetLabel(asset: MediaAssetDTO): string {
  if (asset.source === "render") return "joined video";
  if (asset.source === "upload") return "uploaded image";
  return KIND_NOUN[asset.kind];
}

export function StudioClient({
  imageModels,
  videoModels,
  speechModels,
  render,
  initialAssets,
  initialNextOffset,
  isAdmin,
  project,
}: {
  imageModels: StudioModel[];
  videoModels: StudioModel[];
  speechModels: StudioModel[];
  render: RenderSupport;
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
        ? asset.source === "render"
          ? "Stop joining these clips and remove the result?"
          : "Stop waiting for this video and remove it? The provider may still charge for it."
        : `Delete this ${assetLabel(asset)}? The file is removed from the server.`;
    if (!confirm(what)) return;
    setDeleting(asset.id);
    try {
      await apiFetch(`/api/media/${asset.id}`, { method: "DELETE" });
      setAssets((list) => list.filter((a) => a.id !== asset.id));
      // What is gone cannot be joined or started from.
      setClipIds((ids) => ids.filter((id) => id !== asset.id));
      setVoiceIds((ids) => ids.filter((id) => id !== asset.id));
      setStartImage((image) => (image?.id === asset.id ? null : image));
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
  const [tab, setTab] = useState<Tab>(
    imageModels.length > 0 ? "image" : videoModels.length > 0 ? "video" : speechModels.length > 0 ? "audio" : "image",
  );
  const [modelIds, setModelIds] = useState<Record<Kind, string>>({
    image: imageModels[0]?.id ?? "",
    video: videoModels[0]?.id ?? "",
    audio: speechModels[0]?.id ?? "",
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
  // Video: the picture it starts from (image-to-video).
  const [startImage, setStartImage] = useState<MediaAssetDTO | null>(null);
  const [pickingImage, setPickingImage] = useState(false);
  // Voice.
  const [speechText, setSpeechText] = useState("");
  const [voice, setVoice] = useState("");
  const [speed, setSpeed] = useState("");
  // Join: clips in the order they are shown, voice-overs in the order they are heard.
  const [clipIds, setClipIds] = useState<string[]>([]);
  const [voiceIds, setVoiceIds] = useState<string[]>([]);
  const [joinRatio, setJoinRatio] = useState("");
  const [joinFit, setJoinFit] = useState<"contain" | "cover">("contain");
  const [joinSubtitles, setJoinSubtitles] = useState(true);
  const [joinClipAudio, setJoinClipAudio] = useState(false);
  const [joinTitle, setJoinTitle] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  /** Where an upload goes once it is stored: into the library, or also in front of the video. */
  const uploadFor = useRef<"library" | "start">("library");

  const kind: Kind = tab === "join" ? "video" : tab;
  const models = tab === "image" ? imageModels : tab === "video" ? videoModels : tab === "audio" ? speechModels : [];
  const model = tab === "join" ? null : (models.find((m) => m.id === modelIds[kind]) ?? models[0] ?? null);
  const api: MediaApi = model?.mediaApi ?? "openai";
  const resolutionHints = tab === "image" || tab === "video" ? RESOLUTION_HINTS[tab][api] : [];
  // Each style takes its own sizing options; the others would be ignored.
  const showResolution = !(tab === "image" && api === "openai");
  const showSize = api !== "xai";
  const hasAnyModel = imageModels.length > 0 || videoModels.length > 0 || speechModels.length > 0;

  const units =
    tab === "image" ? Number(count) || 1 : tab === "video" ? Number(duration) || 0 : speechText.trim().length;
  const estimate =
    model?.price != null && units > 0 ? (tab === "audio" ? (model.price * units) / 1_000_000 : model.price * units) : null;

  // What can go into a joined video, from what the library shows.
  const usable = assets.filter((a) => a.status === "ready" && a.url);
  const clipChoices = usable.filter((a) => a.kind === "video" || a.kind === "image");
  const voiceChoices = usable.filter((a) => a.kind === "audio");
  const imageChoices = usable.filter((a) => a.kind === "image");
  const byId = new Map(assets.map((a) => [a.id, a] as const));
  const pickedClips = clipIds.map((id) => byId.get(id)).filter((a): a is MediaAssetDTO => Boolean(a));
  const pickedVoices = voiceIds.map((id) => byId.get(id)).filter((a): a is MediaAssetDTO => Boolean(a));

  function toggle(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  }
  function move(list: string[], id: string, dir: -1 | 1): string[] {
    const i = list.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return list;
    const next = [...list];
    [next[i], next[j]] = [next[j]!, next[i]!];
    return next;
  }

  async function upload(file: File) {
    setUploading(true);
    setFormError(null);
    setLibraryError(null);
    try {
      const res = await apiUpload<{ asset: MediaAssetDTO }>("/api/media/upload", file);
      setAssets((list) => [res.asset, ...list]);
      if (uploadFor.current === "start") {
        setStartImage(res.asset);
        setPickingImage(false);
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "The upload failed";
      if (uploadFor.current === "start") setFormError(message);
      else setLibraryError(message);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  function chooseFile(target: "library" | "start") {
    uploadFor.current = target;
    fileInput.current?.click();
  }

  function reuse(asset: MediaAssetDTO) {
    const list = asset.kind === "image" ? imageModels : asset.kind === "video" ? videoModels : speechModels;
    setTab(asset.kind);
    if (asset.modelRowId && list.some((m) => m.id === asset.modelRowId)) {
      setModelIds((ids) => ({ ...ids, [asset.kind]: asset.modelRowId! }));
    }
    if (asset.kind === "audio") {
      setSpeechText(asset.prompt);
      setVoice(asset.options.voice ?? "");
      setSpeed(asset.options.speed ? String(asset.options.speed) : "");
    } else {
      setPrompt(asset.prompt);
      setAspectRatio(asset.options.aspectRatio ?? "");
      setResolution(asset.options.resolution ?? "");
      setSize(asset.options.size ?? "");
      if (asset.kind === "video") {
        setDuration(asset.options.durationSeconds ? String(asset.options.durationSeconds) : "");
        // The picture it started from, when it is still in the library.
        const from = asset.options.imageAssetId ? byId.get(asset.options.imageAssetId) : undefined;
        setStartImage(from && from.status === "ready" ? from : null);
      }
      if (asset.options.size) setShowAdvanced(true);
    }
    setFormError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /** Put new assets in front of the library, or reload it when the filter would hide them. */
  async function showNew(added: MediaAssetDTO[], addedKind: Kind) {
    if (everyone || (filter !== "all" && filter !== addedKind)) {
      await load({ filter: "all", everyone: false });
    } else {
      setAssets((list) => [...added, ...list]);
    }
  }

  async function join(e: React.FormEvent) {
    e.preventDefault();
    if (pickedClips.length === 0) return;
    setFormError(null);
    setBusy(true);
    try {
      const res = await apiFetch<{ asset: MediaAssetDTO }>("/api/media/render", {
        method: "POST",
        body: JSON.stringify({
          clipIds: pickedClips.map((a) => a.id),
          narrationIds: pickedVoices.map((a) => a.id),
          aspectRatio: joinRatio || undefined,
          fit: joinFit,
          subtitles: pickedVoices.length > 0 && joinSubtitles,
          keepClipAudio: joinClipAudio,
          title: joinTitle.trim() || undefined,
        }),
      });
      await showNew([res.asset], "video");
      setClipIds([]);
      setVoiceIds([]);
      setJoinTitle("");
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not start joining the clips");
    } finally {
      setBusy(false);
    }
  }

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    if (tab === "join") return join(e);
    if (!model) return;
    setFormError(null);

    if (tab === "audio") {
      setBusy(true);
      try {
        const res = await apiFetch<{ asset: MediaAssetDTO }>("/api/media/speech", {
          method: "POST",
          body: JSON.stringify({
            modelRowId: model.id,
            text: speechText.trim(),
            voice: voice.trim() || undefined,
            speed: speed.trim() ? Number(speed) : undefined,
          }),
        });
        await showNew([res.asset], "audio");
      } catch (err) {
        setFormError(
          err instanceof ApiError && err.status !== 504
            ? err.message
            : "The connection ended before the provider answered. If the audio was generated anyway, it shows up after Refresh.",
        );
      } finally {
        setBusy(false);
      }
      return;
    }

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
      if (tab === "image") {
        const res = await apiFetch<{ assets: MediaAssetDTO[] }>("/api/media/images", {
          method: "POST",
          body: JSON.stringify({ ...common, n: Number(count) || 1 }),
        });
        added = res.assets;
      } else {
        const res = await apiFetch<{ asset: MediaAssetDTO }>("/api/media/videos", {
          method: "POST",
          body: JSON.stringify({
            ...common,
            durationSeconds: duration ? Number(duration) : undefined,
            imageAssetId: startImage?.id,
          }),
        });
        added = [res.asset];
      }
      await showNew(added, tab);
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
  const tabs: Tab[] = ["image", "video", "audio", "join"];
  const noun = tab === "image" ? "image" : tab === "video" ? "video" : "speech";

  /** A small picture of an asset, for the pickers. */
  const thumb = (asset: MediaAssetDTO, className: string) =>
    asset.kind === "image" && asset.url ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={asset.url} alt="" loading="lazy" className={cn("rounded object-cover", className)} />
    ) : (
      <span className={cn("grid place-items-center rounded bg-surface-2 text-ink-3", className)}>
        <Icon name={asset.kind === "audio" ? "audio" : "video"} size={16} />
      </span>
    );

  return (
    <div>
      <PageHeader
        title="Creative Studio"
        description={
          project
            ? `Images, videos and voice-overs generated by the project "${project.title}".`
            : "Generate images, videos and voice-overs through the gateway, and join clips into one video. Everything is kept in your library."
        }
        actions={
          project ? (
            <Link href="/dashboard/studio" className="btn-ghost">
              Show all my media
            </Link>
          ) : undefined
        }
      />

      {/* One hidden picker serves "Upload image" and "start the video from an upload". */}
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
        }}
      />

      {!project && !hasAnyModel && (
        <div className="mb-6">
          <Alert tone="warn">
            No model is set up for image, video or speech generation yet.{" "}
            {isAdmin ? (
              <>
                On the <Link href="/dashboard/models" className="underline">Models</Link> page, add such a model and
                set its type to image, video or speech. Clips that are already in the library can still be joined.
              </>
            ) : (
              "Ask an administrator to add one on the Models page."
            )}
          </Alert>
        </div>
      )}

      {!project && (
        <div className="mb-6">
          <Card>
            <form onSubmit={generate} className="space-y-4">
              <div className="inline-flex flex-wrap rounded-md border border-line p-0.5" role="tablist" aria-label="What to make">
                {tabs.map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="tab"
                    aria-selected={tab === t}
                    onClick={() => {
                      setTab(t);
                      setFormError(null);
                      setPickingImage(false);
                    }}
                    className={cn(
                      "flex items-center gap-2 rounded px-3 py-1.5 text-sm transition",
                      tab === t ? "bg-surface-2 font-medium text-ink" : "text-ink-2 hover:text-ink",
                    )}
                  >
                    <Icon name={TAB_ICON[t]} size={16} /> {TAB_LABEL[t]}
                  </button>
                ))}
              </div>

              {tab === "join" ? (
                !render.available ? (
                  <Alert tone="warn">
                    Joining clips is done by ffmpeg on this server, and it is not installed.{" "}
                    {isAdmin
                      ? "Install ffmpeg (with libx264), or set FFMPEG_PATH to the program, and restart the server."
                      : "Ask an administrator to install it."}
                  </Alert>
                ) : (
                  <>
                    {formError && <Alert tone="danger">{formError}</Alert>}
                    <p className="text-sm text-ink-2">
                      Put clips from your library one after the other into one MP4, on this server. It costs nothing
                      at a provider. Tick the clips in the order they should play.
                    </p>

                    <div>
                      <p className="label">Clips{pickedClips.length > 0 ? ` (${pickedClips.length})` : ""}</p>
                      {clipChoices.length === 0 ? (
                        <p className="mt-1 text-sm text-ink-3">
                          No finished video or image in the library yet. Generate some, or upload an image.
                        </p>
                      ) : (
                        <ul className="mt-2 grid max-h-64 gap-2 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
                          {clipChoices.map((asset) => {
                            const order = clipIds.indexOf(asset.id);
                            return (
                              <li key={asset.id}>
                                <button
                                  type="button"
                                  onClick={() => setClipIds((ids) => (ids.includes(asset.id) || ids.length < MAX_RENDER_CLIPS ? toggle(ids, asset.id) : ids))}
                                  aria-pressed={order >= 0}
                                  className={cn(
                                    "flex w-full items-center gap-2.5 rounded-md border p-2 text-left text-xs transition",
                                    order >= 0 ? "border-signal/60 bg-signal/10" : "border-line hover:border-ink-3",
                                  )}
                                >
                                  {thumb(asset, "h-10 w-10 shrink-0")}
                                  <span className="min-w-0 flex-1">
                                    <span className="line-clamp-2 text-ink-2">{asset.prompt}</span>
                                    <span className="text-ink-3">
                                      {assetLabel(asset)}
                                      {asset.durationSeconds ? ` · ${Math.round(asset.durationSeconds * 10) / 10}s` : ""}
                                    </span>
                                  </span>
                                  {order >= 0 && (
                                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-signal text-[11px] font-semibold text-canvas">
                                      {order + 1}
                                    </span>
                                  )}
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                      {pickedClips.length > 1 && (
                        <ol className="mt-2 flex flex-wrap gap-1.5 text-xs">
                          {pickedClips.map((asset, i) => (
                            <li key={asset.id} className="flex items-center gap-1 rounded border border-line px-1.5 py-1 text-ink-2">
                              <span className="mono text-ink-3">{i + 1}</span>
                              <span className="max-w-[9rem] truncate">{asset.prompt}</span>
                              <button type="button" className="px-1 text-ink-3 hover:text-ink" onClick={() => setClipIds((ids) => move(ids, asset.id, -1))} disabled={i === 0} aria-label={`Move clip ${i + 1} earlier`}>
                                ←
                              </button>
                              <button type="button" className="px-1 text-ink-3 hover:text-ink" onClick={() => setClipIds((ids) => move(ids, asset.id, 1))} disabled={i === pickedClips.length - 1} aria-label={`Move clip ${i + 1} later`}>
                                →
                              </button>
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>

                    <div>
                      <p className="label">Voice-over{pickedVoices.length > 0 ? ` (${pickedVoices.length})` : ""}</p>
                      {voiceChoices.length === 0 ? (
                        <p className="mt-1 text-sm text-ink-3">Optional. Generate one on the Voice tab to lay it over the clips.</p>
                      ) : (
                        <>
                          <ul className="mt-2 grid max-h-48 gap-2 overflow-y-auto sm:grid-cols-2">
                            {voiceChoices.map((asset) => {
                              const order = voiceIds.indexOf(asset.id);
                              return (
                                <li key={asset.id}>
                                  <button
                                    type="button"
                                    onClick={() => setVoiceIds((ids) => toggle(ids, asset.id))}
                                    aria-pressed={order >= 0}
                                    className={cn(
                                      "flex w-full items-center gap-2.5 rounded-md border p-2 text-left text-xs transition",
                                      order >= 0 ? "border-signal/60 bg-signal/10" : "border-line hover:border-ink-3",
                                    )}
                                  >
                                    {thumb(asset, "h-8 w-8 shrink-0")}
                                    <span className="min-w-0 flex-1">
                                      <span className="line-clamp-2 text-ink-2">{asset.prompt}</span>
                                      {asset.durationSeconds ? <span className="text-ink-3">{Math.round(asset.durationSeconds * 10) / 10}s</span> : null}
                                    </span>
                                    {order >= 0 && (
                                      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-signal text-[11px] font-semibold text-canvas">
                                        {order + 1}
                                      </span>
                                    )}
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                          <p className="mt-1.5 text-xs text-ink-3">
                            {pickedVoices.length > 0 && pickedVoices.length === pickedClips.length
                              ? "One voice-over per clip: each starts with its clip, and a clip that is shorter holds its last frame until its voice-over ends."
                              : "As many voice-overs as clips: each plays over its own clip. Any other number: they play one after the other from the start."}
                          </p>
                        </>
                      )}
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                      <Field label="Frame" htmlFor="st-join-ratio">
                        <Select id="st-join-ratio" value={joinRatio} onChange={(e) => setJoinRatio(e.target.value)}>
                          <option value="">As the first clip</option>
                          {ASPECT_RATIOS.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Clips of another shape" htmlFor="st-join-fit">
                        <Select id="st-join-fit" value={joinFit} onChange={(e) => setJoinFit(e.target.value as "contain" | "cover")}>
                          <option value="contain">Show whole, with bars</option>
                          <option value="cover">Fill the frame, cropped</option>
                        </Select>
                      </Field>
                      <Field label="Title" htmlFor="st-join-title" hint="Optional, for the library.">
                        <Input id="st-join-title" value={joinTitle} onChange={(e) => setJoinTitle(e.target.value)} maxLength={200} />
                      </Field>
                      <div className="flex flex-col justify-center gap-1.5 text-sm text-ink-2">
                        <label className={cn("flex items-center gap-2", pickedVoices.length === 0 || !render.subtitles ? "opacity-50" : "cursor-pointer")}>
                          <input
                            type="checkbox"
                            className="accent-current"
                            checked={joinSubtitles && pickedVoices.length > 0 && render.subtitles}
                            disabled={pickedVoices.length === 0 || !render.subtitles}
                            onChange={(e) => setJoinSubtitles(e.target.checked)}
                          />
                          Subtitles from the voice-over
                        </label>
                        <label className="flex cursor-pointer items-center gap-2">
                          <input type="checkbox" className="accent-current" checked={joinClipAudio} onChange={(e) => setJoinClipAudio(e.target.checked)} />
                          Keep the clips&apos; own sound
                        </label>
                      </div>
                    </div>
                    {!render.subtitles && (
                      <p className="text-xs text-ink-3">This server&apos;s ffmpeg cannot draw subtitles (it was built without libass).</p>
                    )}

                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="text-xs text-ink-3">
                        The result is one MP4 (H.264, 1080 pixels on the short side). It is made in the background: you
                        can leave this page.
                      </p>
                      <Button type="submit" loading={busy} disabled={pickedClips.length === 0}>
                        <Icon name="render" size={16} /> Join {pickedClips.length || ""} {pickedClips.length === 1 ? "clip" : "clips"}
                      </Button>
                    </div>
                  </>
                )
              ) : models.length === 0 ? (
                <Alert tone="warn">
                  No model is marked for {noun} generation yet.{" "}
                  {isAdmin ? "Add one on the Models page and set its type." : "Ask an administrator to add one."}
                </Alert>
              ) : tab === "audio" ? (
                <>
                  {formError && <Alert tone="danger">{formError}</Alert>}
                  <Field label="Text to speak" htmlFor="st-speech" hint={`${speechText.length} / ${MAX_SPEECH_CHARS}`}>
                    <Textarea
                      id="st-speech"
                      value={speechText}
                      onChange={(e) => setSpeechText(e.target.value)}
                      required
                      maxLength={MAX_SPEECH_CHARS}
                      className="min-h-[110px]"
                      placeholder="Welcome back. Today we look at how a lighthouse lamp is turned…"
                    />
                  </Field>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field label="Model" htmlFor="st-model">
                      <Select id="st-model" value={model?.id ?? ""} onChange={(e) => setModelIds((ids) => ({ ...ids, audio: e.target.value }))}>
                        {models.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Voice" htmlFor="st-voice" hint="The provider's name for it. Empty: its default.">
                      <Input id="st-voice" value={voice} onChange={(e) => setVoice(e.target.value)} list="st-voices" maxLength={64} placeholder="alloy" />
                      <datalist id="st-voices">
                        {VOICE_HINTS.map((v) => (
                          <option key={v} value={v} />
                        ))}
                      </datalist>
                    </Field>
                    <Field label="Speed" htmlFor="st-speed" hint="1 is normal. Not every provider has it.">
                      <Input id="st-speed" type="number" min={MIN_SPEECH_SPEED} max={MAX_SPEECH_SPEED} step={0.05} value={speed} onChange={(e) => setSpeed(e.target.value)} placeholder="1" />
                    </Field>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs text-ink-3">
                      {estimate != null
                        ? `Estimated cost ${formatCost(estimate)} (${formatNumber(units)} characters × ${formatCost(model?.price)} per million), from the price set on the model.`
                        : model?.price == null
                          ? "No price per million characters is set on this model, so no estimate. The provider still bills it."
                          : "The provider bills by the length of the text."}
                    </p>
                    <Button type="submit" loading={busy} disabled={!speechText.trim()}>
                      <Icon name="audio" size={16} /> {busy ? "Generating…" : "Generate voice"}
                    </Button>
                  </div>
                </>
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
                        tab === "image"
                          ? "A lighthouse on a cliff at dusk, long exposure, soft orange light…"
                          : startImage
                            ? "How the picture comes to life: the waves start to move, the camera pushes in slowly…"
                            : "Slow push-in on a lighthouse at dusk, waves breaking below, gulls crossing the frame…"
                      }
                    />
                  </Field>

                  {tab === "video" && (
                    <div className="rounded-md border border-line bg-surface-2/40 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-3">
                          {startImage ? thumb(startImage, "h-12 w-12 shrink-0") : null}
                          <div className="min-w-0">
                            <p className="text-sm text-ink">
                              {startImage ? "Starts from this image" : "Start from an image (optional)"}
                            </p>
                            <p className="truncate text-xs text-ink-3">
                              {startImage
                                ? startImage.prompt
                                : "The clip opens on the picture and animates it. The model has to take a first frame; not every video model does."}
                            </p>
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-wrap gap-2">
                          {startImage && (
                            <Button type="button" variant="ghost" onClick={() => setStartImage(null)}>
                              <Icon name="x" size={14} /> Remove
                            </Button>
                          )}
                          <Button type="button" variant="ghost" onClick={() => setPickingImage((v) => !v)} aria-expanded={pickingImage}>
                            <Icon name="image" size={14} /> {startImage ? "Change" : "From the library"}
                          </Button>
                          <Button type="button" variant="ghost" onClick={() => chooseFile("start")} loading={uploading}>
                            <Icon name="upload" size={14} /> Upload
                          </Button>
                        </div>
                      </div>
                      {pickingImage &&
                        (imageChoices.length === 0 ? (
                          <p className="mt-3 text-xs text-ink-3">No finished image in the library. Generate one, or upload one.</p>
                        ) : (
                          <ul className="mt-3 flex max-h-44 flex-wrap gap-2 overflow-y-auto">
                            {imageChoices.map((asset) => (
                              <li key={asset.id}>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setStartImage(asset);
                                    setPickingImage(false);
                                  }}
                                  title={asset.prompt}
                                  aria-label={`Start from: ${asset.prompt.slice(0, 80)}`}
                                  className={cn(
                                    "block rounded border-2 transition",
                                    startImage?.id === asset.id ? "border-signal" : "border-transparent hover:border-ink-3",
                                  )}
                                >
                                  {thumb(asset, "h-16 w-16")}
                                </button>
                              </li>
                            ))}
                          </ul>
                        ))}
                    </div>
                  )}

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
                      hint={tab === "image" && api === "openai" ? "Sent as a square, portrait or landscape size." : undefined}
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
                    {tab === "image" ? (
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
                    onClick={() => setShowAdvanced((v) => !v)}
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
                            placeholder={tab === "image" ? "1024x1536" : "720x1280"}
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
                        ? `Estimated cost ${formatCost(estimate)} (${units} ${tab === "image" ? (units === 1 ? "image" : "images") : "s"} × ${formatCost(model?.price)}), from the price set on the model.`
                        : model?.price == null
                          ? `No ${tab === "image" ? "per-image" : "per-second"} price is set on this model, so no estimate. The provider still bills it.`
                          : "The provider bills each generation."}
                    </p>
                    <Button type="submit" loading={busy} disabled={!prompt.trim()}>
                      <Icon name="studio" size={16} /> {busy ? "Generating…" : tab === "image" ? "Generate" : "Start video"}
                    </Button>
                  </div>
                  {busy && tab === "image" && (
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
          {(["all", "image", "video", "audio"] as const).map((f) => (
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
              {f === "all" ? "All" : f === "image" ? "Images" : f === "video" ? "Videos" : "Voice"}
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
              {pendingCount} in progress · they finish in the background
            </span>
          )}
          {!project && (
            <Button variant="ghost" onClick={() => chooseFile("library")} loading={uploading} title="Add your own picture: to start a video from, or as a still in a joined video">
              <Icon name="upload" size={16} /> Upload image
            </Button>
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
              : "Images, videos and voice-overs you generate, here or in a project, are listed here."
          }
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {assets.map((asset) => {
            const summary = optionSummary(asset);
            const made = asset.source === "provider";
            return (
              <li key={asset.id} className="card flex flex-col p-3">
                <MediaView asset={asset} />
                <div className="mt-3 flex flex-1 flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
                    <Badge tone={asset.kind === "video" ? "info" : asset.kind === "audio" ? "signal" : "neutral"}>{assetLabel(asset)}</Badge>
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
                  {asset.status === "ready" && asset.error && (
                    <p className="rounded border border-warn/30 bg-warn/10 px-2.5 py-1.5 text-xs text-warn">{asset.error}</p>
                  )}
                  {asset.status === "pending" && checkErrors[asset.id] && (
                    <p className="rounded border border-warn/30 bg-warn/10 px-2.5 py-1.5 text-xs text-warn">
                      Could not check on it just now: {checkErrors[asset.id]} Trying again.
                    </p>
                  )}
                  <p className="text-xs text-ink-3">
                    <Dotted
                      parts={[
                        summary,
                        asset.sizeBytes != null ? formatBytes(asset.sizeBytes) : null,
                        asset.estimatedCost != null ? `est. ${formatCost(asset.estimatedCost)}` : null,
                        <RelativeTime key="when" at={asset.createdAt} />,
                      ]}
                    />
                  </p>
                  <div className="mt-auto flex flex-wrap items-center gap-1 pt-1">
                    {asset.url && (
                      <a href={`${asset.url}?download=1`} className="btn-ghost px-2 py-1 text-xs" download>
                        <Icon name="download" size={14} /> Download
                      </a>
                    )}
                    {made && (
                      <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => void copyPrompt(asset)}>
                        <Icon name={copied?.id === asset.id && copied.ok ? "check" : "copy"} size={14} />{" "}
                        <span aria-live="polite">
                          {copied?.id !== asset.id ? (asset.kind === "audio" ? "Copy text" : "Copy prompt") : copied.ok ? "Copied" : "Could not copy"}
                        </span>
                      </button>
                    )}
                    {!project && made && hasAnyModel && (
                      <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => reuse(asset)}>
                        <Icon name="refresh" size={14} /> Use again
                      </button>
                    )}
                    {!project && asset.kind === "image" && asset.status === "ready" && videoModels.length > 0 && (
                      <button
                        type="button"
                        className="btn-ghost px-2 py-1 text-xs"
                        onClick={() => {
                          setTab("video");
                          setStartImage(asset);
                          setPickingImage(false);
                          setFormError(null);
                          window.scrollTo({ top: 0, behavior: "smooth" });
                        }}
                        title="Start a video from this image"
                      >
                        <Icon name="video" size={14} /> Animate
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
                      aria-label={`Delete this ${assetLabel(asset)}`}
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
