import "server-only";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, asc, count, desc, eq, lt } from "drizzle-orm";
import { db } from "@/db";
import {
  mediaAssets,
  modelCapabilities,
  models,
  providers,
  users,
  type MediaAsset,
  type User,
} from "@/db/schema";
import { getAdapter } from "../adapters";
import {
  MAX_IMAGES_PER_REQUEST,
  type ParsedImage,
  type ParsedVideoJob,
} from "../adapters/media-protocol";
import type {
  MediaDownload,
  ProviderAdapter,
  ProviderContext,
  SpeechFormat,
} from "../adapters/types";
import { MEDIA_CAPABILITY } from "../capabilities";
import { MAX_SPEECH_CHARS, parseMediaOptions, type MediaOptions } from "../creative/prompt";
import { AppError, Errors, sanitizeUpstreamError } from "../errors";
import { contextFor, resolveEnabledModel, type ResolvedModel } from "../gateway";
import { safeFetch } from "../http-client";
import { notify } from "../notifications";
import { currentApiKeyId } from "../request-context";
import { runtime } from "../runtime";
import { assertTokensLeft } from "../tokens";
import { estimateTokens, recordUsage } from "../usage";
import { computeImageCost, computeSpeechCost, computeVideoCost } from "./cost";
import { ffmpegStatusNow, probeFile } from "./ffmpeg";
import { MAX_IMAGE_BYTES, mimeForFileName, pcmToWav, sniffMedia, type MediaKind } from "./files";
import { readBodyCapped } from "./http";
import { inputFormat, wavDurationSeconds } from "./render-plan";
import {
  deleteMediaFile,
  mediaFilePath,
  saveMediaBytes,
  saveMediaResponse,
  type StoredFile,
} from "./store";
import { isAdminRole } from "@/lib/roles";

/**
 * Image, video and speech generation through the gateway.
 *
 * An image or speech request waits for the provider and stores the file. A
 * video is a job: `startVideo` creates a `pending` asset, and `refreshVideo`
 * asks the provider about it and, once it is finished, downloads the file.
 * The background worker refreshes pending videos, so they finish whether or
 * not a page is open; a page or a project run that is waiting asks as well.
 */

/** How long an image request may take until the provider answers. */
const IMAGE_TIMEOUT_MS = 180_000;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 60_000;
const SPEECH_TIMEOUT_MS = 180_000;
/** Largest picture sent to a provider as the first frame of a video. */
export const MAX_FIRST_FRAME_BYTES = 10 * 1024 * 1024;
const VIDEO_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/** A provider is asked about one job at most this often. */
const VIDEO_MIN_POLL_INTERVAL_MS = 3_000;
/** A job that is still not finished after this long is given up on. */
export const VIDEO_JOB_MAX_AGE_MS = 60 * 60_000;
/** Videos one user may have in progress at a time. */
export const MAX_PENDING_VIDEOS_PER_USER = 12;
const MAX_REDIRECTS = 3;

// ─── Models ──────────────────────────────────────────────────────────────────

const KIND_NOUN: Record<MediaKind, string> = { image: "image", video: "video", audio: "speech" };

/** An enabled model that is marked for this kind of media, or a safe error. */
export function resolveMediaModel(modelRowId: string, kind: MediaKind): ResolvedModel {
  const resolved = resolveEnabledModel(modelRowId);
  const marked = db
    .select({ id: modelCapabilities.id })
    .from(modelCapabilities)
    .where(
      and(
        eq(modelCapabilities.modelRowId, resolved.model.id),
        eq(modelCapabilities.capability, MEDIA_CAPABILITY[kind]),
      ),
    )
    .get();
  if (!marked) {
    throw Errors.badRequest(
      `This model is not marked for ${KIND_NOUN[kind]} generation. An administrator can add that capability on the Models page.`,
    );
  }
  const adapter = getAdapter(resolved.provider.adapter);
  const able =
    kind === "image"
      ? adapter.generateImages
      : kind === "video"
        ? adapter.startVideo && adapter.getVideo
        : adapter.generateSpeech;
  if (!able) {
    throw Errors.badRequest(
      `The ${adapter.label} adapter cannot generate ${KIND_NOUN[kind]}${kind === "audio" ? "" : "s"}. ` +
        "Use a model of a provider whose adapter can.",
    );
  }
  return resolved;
}

function modelLabel(resolved: ResolvedModel): string {
  return resolved.model.displayName || resolved.model.modelId;
}

/** A successful generation proves the capability an administrator ticked. */
function markVerified(modelRowId: string, kind: MediaKind): void {
  try {
    db.update(modelCapabilities)
      .set({ verified: true })
      .where(
        and(
          eq(modelCapabilities.modelRowId, modelRowId),
          eq(modelCapabilities.capability, MEDIA_CAPABILITY[kind]),
        ),
      )
      .run();
  } catch {
    /* cosmetic */
  }
}

/** A safe error for the client; anything unexpected is logged and replaced. */
function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  // eslint-disable-next-line no-console
  console.error("[xiero-nexus] media error:", err);
  return new AppError(
    500,
    "media_error",
    "Could not store the generated media. Check the server log and the media folder.",
  );
}

function optionsJson(options: MediaOptions): string | null {
  const clean: MediaOptions = {};
  if (options.aspectRatio) clean.aspectRatio = options.aspectRatio;
  if (options.durationSeconds) clean.durationSeconds = options.durationSeconds;
  if (options.resolution) clean.resolution = options.resolution;
  if (options.size) clean.size = options.size;
  if (options.voice) clean.voice = options.voice;
  if (options.speed) clean.speed = options.speed;
  if (options.imageAssetId) clean.imageAssetId = options.imageAssetId;
  return Object.keys(clean).length ? JSON.stringify(clean) : null;
}

// ─── Downloads ───────────────────────────────────────────────────────────────

/**
 * Fetch a file the provider pointed at. Redirects are followed by hand, at
 * most a few, so that every address is checked against private ranges and the
 * provider's key is only ever sent to the provider's own origin.
 */
async function fetchDownload(
  first: MediaDownload,
  adapter: ProviderAdapter,
  ctx: ProviderContext,
  timeoutMs: number,
): Promise<Response> {
  let current = first;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await safeFetch(
      current.url,
      { method: "GET", headers: current.authHeaders },
      { timeoutMs, allowHosts: ctx.allowHosts, redirect: "manual" },
    );
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      void res.body?.cancel().catch(() => undefined);
      let next: MediaDownload | null = null;
      if (location) {
        try {
          next = adapter.mediaDownload?.(ctx, new URL(location, current.url).toString()) ?? null;
        } catch {
          next = null;
        }
      }
      if (!next) {
        throw new AppError(502, "upstream_error", "The provider redirected the download to an address that cannot be used");
      }
      current = next;
      continue;
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      throw new AppError(
        502,
        res.status === 404 || res.status === 410 ? "upstream_not_found" : "upstream_error",
        `Downloading the file failed: the provider responded ${res.status}`,
      );
    }
    return res;
  }
  throw new AppError(502, "upstream_error", "Too many redirects while downloading the file");
}

async function imageBytes(
  image: ParsedImage,
  adapter: ProviderAdapter,
  ctx: ProviderContext,
): Promise<Buffer> {
  if (image.b64) {
    // Base64 is a third larger than the bytes it encodes.
    if (image.b64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 16) {
      throw new AppError(502, "upstream_too_large", "The generated image is larger than the limit");
    }
    return Buffer.from(image.b64, "base64");
  }
  const download = image.url ? adapter.mediaDownload?.(ctx, image.url) : null;
  if (!download) {
    throw new AppError(502, "upstream_error", "The provider returned an image link that cannot be used");
  }
  const res = await fetchDownload(download, adapter, ctx, IMAGE_DOWNLOAD_TIMEOUT_MS);
  return readBodyCapped(res, { maxBytes: MAX_IMAGE_BYTES, timeoutMs: IMAGE_DOWNLOAD_TIMEOUT_MS });
}

// ─── Images ──────────────────────────────────────────────────────────────────

export interface MediaRequestBase {
  /** Who the media belongs to. Null when that user no longer exists. */
  userId: string | null;
  modelRowId: string;
  prompt: string;
  aspectRatio?: string;
  resolution?: string;
  size?: string;
  /** Provider-specific parameters, sent as given. */
  extra?: Record<string, unknown>;
  /** Set when a project run generates the media. */
  projectId?: string | null;
  taskId?: string | null;
}

export interface GenerateImagesInput extends MediaRequestBase {
  n?: number;
}

/** Generate images and store them. Resolves to the new assets, all `ready`. */
export async function generateImages(input: GenerateImagesInput): Promise<MediaAsset[]> {
  assertTokensLeft(input.userId, input.projectId ? "project" : "yours");
  const resolved = resolveMediaModel(input.modelRowId, "image");
  const adapter = getAdapter(resolved.provider.adapter);
  const wanted = Math.min(Math.max(1, Math.round(input.n ?? 1)), MAX_IMAGES_PER_REQUEST);
  const started = Date.now();
  const stored: { id: string; file: StoredFile }[] = [];
  let committed = false;

  try {
    const ctx = contextFor(resolved.provider);
    const parsed = await adapter.generateImages!(
      ctx,
      {
        model: resolved.model.modelId,
        prompt: input.prompt,
        n: wanted,
        aspectRatio: input.aspectRatio,
        resolution: input.resolution,
        size: input.size,
        extra: input.extra,
      },
      { timeoutMs: Math.max(resolved.provider.timeoutMs, IMAGE_TIMEOUT_MS) },
    );
    if (parsed.images.length === 0) {
      throw new AppError(
        502,
        "upstream_error",
        parsed.error
          ? `Provider error: ${sanitizeUpstreamError(parsed.error)}`
          : "The provider answered without an image",
      );
    }

    let lastError: unknown = null;
    for (const image of parsed.images.slice(0, wanted)) {
      const id = randomUUID();
      try {
        const bytes = await imageBytes(image, adapter, ctx);
        stored.push({ id, file: await saveMediaBytes(id, "image", bytes) });
      } catch (err) {
        lastError = err;
      }
    }
    if (stored.length === 0) throw lastError;

    const cost = computeImageCost(resolved.model, {
      images: stored.length,
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
    });
    const now = new Date();
    const params = optionsJson({
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      size: input.size,
    });
    const rows = db.transaction((tx) =>
      stored.map(({ id, file }) =>
        tx
          .insert(mediaAssets)
          .values({
            id,
            userId: input.userId,
            projectId: input.projectId ?? null,
            taskId: input.taskId ?? null,
            kind: "image",
            status: "ready",
            providerId: resolved.provider.id,
            modelRowId: resolved.model.id,
            modelLabel: modelLabel(resolved),
            apiKeyId: currentApiKeyId(),
            prompt: input.prompt,
            params,
            fileName: file.fileName,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
            estimatedCost: cost === null ? null : cost / stored.length,
            createdAt: now,
            updatedAt: now,
            completedAt: now,
          })
          .returning()
          .get(),
      ),
    );
    committed = true;

    recordUsage({
      userId: input.userId,
      providerId: resolved.provider.id,
      modelRowId: resolved.model.id,
      kind: "image",
      // A provider that counts no tokens for an image: the prompt is what was sent.
      promptTokens: parsed.inputTokens ?? estimateTokens(input.prompt),
      completionTokens: parsed.outputTokens ?? 0,
      estimatedCost: cost,
      status: "ok",
      latencyMs: Date.now() - started,
    });
    markVerified(resolved.model.id, "image");
    return rows;
  } catch (err) {
    if (committed) throw err;
    await Promise.all(stored.map((s) => deleteMediaFile(s.file.fileName)));
    const safe = toAppError(err);
    recordUsage({
      userId: input.userId,
      providerId: resolved.provider.id,
      modelRowId: resolved.model.id,
      kind: "image",
      status: "error",
      errorCode: safe.code,
      latencyMs: Date.now() - started,
    });
    throw safe;
  }
}

// ─── Videos ──────────────────────────────────────────────────────────────────

export interface StartVideoInput extends MediaRequestBase {
  durationSeconds?: number;
  /**
   * An image asset the video starts from (image-to-video). The caller has
   * checked that the requester may use it.
   */
  imageAssetId?: string;
}

/** A stored picture as a `data:` URL, for a provider that takes a first frame. */
async function firstFrame(assetId: string): Promise<string> {
  const image = loadAsset(assetId);
  if (!image || image.kind !== "image" || image.status !== "ready" || !image.fileName) {
    throw Errors.badRequest("The image to start from was not found");
  }
  if ((image.sizeBytes ?? 0) > MAX_FIRST_FRAME_BYTES) {
    throw Errors.badRequest(
      `The image to start from is larger than ${Math.round(MAX_FIRST_FRAME_BYTES / (1024 * 1024))} MB`,
    );
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(mediaFilePath(image.fileName));
  } catch {
    throw Errors.badRequest("The image to start from is no longer on disk");
  }
  const mime = mimeForFileName(image.fileName) ?? "image/png";
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

export function pendingVideoCount(userId: string): number {
  const row = db
    .select({ n: count() })
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.userId, userId),
        eq(mediaAssets.kind, "video"),
        eq(mediaAssets.status, "pending"),
      ),
    )
    .get();
  return row?.n ?? 0;
}

/**
 * Submit a video job. Resolves to a `pending` asset; `refreshVideo` moves it
 * to `ready` or `failed`.
 */
export async function startVideo(input: StartVideoInput): Promise<MediaAsset> {
  assertTokensLeft(input.userId, input.projectId ? "project" : "yours");
  const resolved = resolveMediaModel(input.modelRowId, "video");
  const adapter = getAdapter(resolved.provider.adapter);
  const started = Date.now();

  let job: ParsedVideoJob;
  try {
    const image = input.imageAssetId ? await firstFrame(input.imageAssetId) : undefined;
    const ctx = contextFor(resolved.provider);
    job = await adapter.startVideo!(ctx, {
      model: resolved.model.modelId,
      prompt: input.prompt,
      durationSeconds: input.durationSeconds,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      size: input.size,
      image,
      extra: input.extra,
    });
    if (job.state === "failed") {
      throw new AppError(
        502,
        "upstream_error",
        `Provider error: ${sanitizeUpstreamError(job.error ?? "the video was rejected")}`,
      );
    }
    if (!job.id) {
      throw new AppError(502, "upstream_error", "The provider accepted the request but returned no job id");
    }
  } catch (err) {
    const safe = toAppError(err);
    recordUsage({
      userId: input.userId,
      providerId: resolved.provider.id,
      modelRowId: resolved.model.id,
      kind: "video",
      status: "error",
      errorCode: safe.code,
      latencyMs: Date.now() - started,
    });
    throw safe;
  }

  const now = new Date();
  const asset = db
    .insert(mediaAssets)
    .values({
      id: randomUUID(),
      userId: input.userId,
      projectId: input.projectId ?? null,
      taskId: input.taskId ?? null,
      kind: "video",
      status: "pending",
      providerId: resolved.provider.id,
      modelRowId: resolved.model.id,
      modelLabel: modelLabel(resolved),
      apiKeyId: currentApiKeyId(),
      prompt: input.prompt,
      params: optionsJson({
        aspectRatio: input.aspectRatio,
        durationSeconds: input.durationSeconds,
        resolution: input.resolution,
        size: input.size,
        imageAssetId: input.imageAssetId,
      }),
      providerJobId: job.id,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();

  // Some gateways answer with a finished job straight away.
  if (job.state === "done") return (await refreshVideo(asset.id, { force: true })).asset;
  return asset;
}

export interface RefreshResult {
  asset: MediaAsset;
  /**
   * Why the provider could not be asked, or the file not fetched, this time.
   * The asset is unchanged and still pending; the next refresh tries again.
   */
  checkError?: string;
}

function loadAsset(assetId: string): MediaAsset | undefined {
  return db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId)).get();
}

function tooOld(asset: MediaAsset): boolean {
  return Date.now() - asset.createdAt.getTime() > VIDEO_JOB_MAX_AGE_MS;
}

/**
 * Tell the owner that a video from Creative Studio or the API is finished. A
 * project run reports on its own videos.
 */
function announceVideo(asset: MediaAsset): void {
  if (asset.taskId) return;
  const about = asset.prompt.length > 120 ? `${asset.prompt.slice(0, 119)}…` : asset.prompt;
  notify(asset.userId, {
    kind: "media",
    level: asset.status === "ready" ? "success" : "error",
    title: asset.status === "ready" ? "Your video is ready" : "A video could not be generated",
    body: asset.status === "ready" ? about : `${asset.error ?? "The provider failed."}\n${about}`,
    link: "/dashboard/studio",
  });
}

/** Mark a pending video as failed. Returns the row as it is afterwards. */
function failVideo(asset: MediaAsset, message: string, errorCode: string): MediaAsset {
  const now = new Date();
  const updated = db
    .update(mediaAssets)
    .set({
      status: "failed",
      error: sanitizeUpstreamError(message),
      lastCheckedAt: now,
      completedAt: now,
      updatedAt: now,
    })
    .where(and(eq(mediaAssets.id, asset.id), eq(mediaAssets.status, "pending")))
    .returning()
    .get();
  if (!updated) return loadAsset(asset.id) ?? asset;
  recordUsage({
    userId: asset.userId,
    providerId: asset.providerId,
    modelRowId: asset.modelRowId,
    apiKeyId: asset.apiKeyId,
    kind: "video",
    status: "error",
    errorCode,
    latencyMs: now.getTime() - asset.createdAt.getTime(),
  });
  announceVideo(updated);
  return updated;
}

function touch(asset: MediaAsset): MediaAsset {
  const now = new Date();
  return (
    db
      .update(mediaAssets)
      .set({ lastCheckedAt: now, updatedAt: now })
      .where(eq(mediaAssets.id, asset.id))
      .returning()
      .get() ?? asset
  );
}

/** Errors that will be the same however often the download is tried again. */
const FINAL_DOWNLOAD_ERRORS = new Set(["unsupported_media", "upstream_too_large"]);

async function refreshNow(asset: MediaAsset): Promise<RefreshResult> {
  const provider = asset.providerId
    ? db.select().from(providers).where(eq(providers.id, asset.providerId)).get()
    : undefined;
  if (!provider) {
    return { asset: failVideo(asset, "The provider was deleted before the video was finished", "provider_deleted") };
  }
  if (!asset.providerJobId) {
    return { asset: failVideo(asset, "The video job id is missing", "no_job_id") };
  }

  /** Not final: keep the asset pending unless the job is too old to keep trying. */
  const notYet = (reason: string, code: string): RefreshResult => {
    if (tooOld(asset)) {
      return { asset: failVideo(asset, `Gave up after an hour. Last problem: ${reason}`, code) };
    }
    return { asset: touch(asset), checkError: sanitizeUpstreamError(reason) };
  };

  if (provider.status !== "enabled") return notYet("The provider is disabled", "provider_disabled");

  let adapter: ProviderAdapter;
  let ctx: ProviderContext;
  let job: ParsedVideoJob;
  try {
    adapter = getAdapter(provider.adapter);
    if (!adapter.getVideo || !adapter.videoDownload) {
      return { asset: failVideo(asset, "The provider's adapter no longer supports video", "adapter_unavailable") };
    }
    ctx = contextFor(provider);
    job = await adapter.getVideo(ctx, asset.providerJobId);
  } catch (err) {
    const safe = toAppError(err);
    if (safe.code === "upstream_not_found") {
      return { asset: failVideo(asset, "The provider no longer has this video job", safe.code) };
    }
    return notYet(safe.message, safe.code);
  }

  if (job.state === "failed") {
    return { asset: failVideo(asset, job.error ?? "The provider could not generate the video", "generation_failed") };
  }
  if (job.state === "pending") {
    if (tooOld(asset)) {
      return { asset: failVideo(asset, "The provider did not finish the video within an hour", "timeout") };
    }
    return { asset: touch(asset) };
  }

  // Finished: fetch the file.
  let file: StoredFile;
  try {
    const download = adapter.videoDownload(ctx, asset.providerJobId, job);
    const res = await fetchDownload(download, adapter, ctx, Math.max(provider.timeoutMs, 60_000));
    file = await saveMediaResponse(asset.id, "video", res, VIDEO_DOWNLOAD_TIMEOUT_MS);
  } catch (err) {
    const safe = toAppError(err);
    if (FINAL_DOWNLOAD_ERRORS.has(safe.code)) {
      return { asset: failVideo(asset, safe.message, safe.code) };
    }
    return notYet(safe.message, safe.code);
  }

  const requested = parseMediaOptions(asset.params).durationSeconds ?? null;
  const seconds = job.durationSeconds ?? requested;
  const model = asset.modelRowId
    ? db.select().from(models).where(eq(models.id, asset.modelRowId)).get()
    : undefined;
  const cost = model ? computeVideoCost(model, seconds) : null;
  const now = new Date();
  const updated = db
    .update(mediaAssets)
    .set({
      status: "ready",
      fileName: file.fileName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      durationSeconds: seconds,
      estimatedCost: cost,
      error: null,
      lastCheckedAt: now,
      completedAt: now,
      updatedAt: now,
    })
    .where(and(eq(mediaAssets.id, asset.id), eq(mediaAssets.status, "pending")))
    .returning()
    .get();
  if (!updated) {
    // Deleted while the file was downloading.
    await deleteMediaFile(file.fileName);
    return { asset: loadAsset(asset.id) ?? { ...asset, status: "failed", error: "Deleted" } };
  }

  recordUsage({
    userId: asset.userId,
    providerId: asset.providerId,
    modelRowId: asset.modelRowId,
    apiKeyId: asset.apiKeyId,
    kind: "video",
    // No provider counts tokens for a video: the prompt is what was sent.
    promptTokens: estimateTokens(asset.prompt),
    estimatedCost: cost,
    status: "ok",
    latencyMs: now.getTime() - asset.createdAt.getTime(),
  });
  if (asset.modelRowId) markVerified(asset.modelRowId, "video");
  announceVideo(updated);
  return { asset: updated };
}

/**
 * One refresh per asset at a time, shared by everyone who asks meanwhile: the
 * Studio page, a project run and the background worker. The map is one per
 * server process (see runtime.ts).
 */
function refreshing(): Map<string, Promise<RefreshResult>> {
  return runtime().refreshing as Map<string, Promise<RefreshResult>>;
}

/**
 * Ask the provider about a pending video and, when it is finished, download
 * it. Safe to call often and from several places at once: calls are shared
 * while one is running, and the provider is not asked more than once every
 * few seconds. Anything that is not a provider's pending video is returned as
 * it is: a video being joined on this server moves forward by itself.
 */
export async function refreshVideo(
  assetId: string,
  opts: { force?: boolean } = {},
): Promise<RefreshResult> {
  const running = refreshing().get(assetId);
  if (running) return running;

  const asset = loadAsset(assetId);
  if (!asset) throw Errors.notFound("Media not found");
  if (asset.kind !== "video" || asset.status !== "pending" || asset.source !== "provider") {
    return { asset };
  }
  if (
    !opts.force &&
    asset.lastCheckedAt &&
    Date.now() - asset.lastCheckedAt.getTime() < VIDEO_MIN_POLL_INTERVAL_MS
  ) {
    return { asset };
  }

  const work = refreshNow(asset).finally(() => refreshing().delete(assetId));
  refreshing().set(assetId, work);
  return work;
}

/** How often the background worker asks a provider about one video. */
const BACKGROUND_POLL_INTERVAL_MS = 10_000;

/**
 * Move every pending video forward. Called by the background worker, so that
 * a video finishes and is downloaded with no page open. Returns the assets
 * that reached `ready` or `failed` in this call.
 */
export async function refreshPendingVideos(limit = 20): Promise<MediaAsset[]> {
  const due = db
    .select({ id: mediaAssets.id, lastCheckedAt: mediaAssets.lastCheckedAt })
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.kind, "video"),
        eq(mediaAssets.status, "pending"),
        eq(mediaAssets.source, "provider"),
      ),
    )
    .orderBy(asc(mediaAssets.lastCheckedAt))
    .limit(limit * 3)
    .all()
    .filter(
      (a) => !a.lastCheckedAt || Date.now() - a.lastCheckedAt.getTime() >= BACKGROUND_POLL_INTERVAL_MS,
    )
    .slice(0, limit);
  const finished: MediaAsset[] = [];
  await Promise.all(
    due.map(async ({ id }) => {
      try {
        const { asset } = await refreshVideo(id);
        if (asset.status !== "pending") finished.push(asset);
      } catch {
        /* deleted meanwhile, or a problem that the next round sees again */
      }
    }),
  );
  return finished;
}

/**
 * Give up on renders that were never finished: their job was lost, or the
 * server stopped for good while ffmpeg ran.
 */
export function failStaleRenders(maxAgeMs: number): MediaAsset[] {
  const now = new Date();
  return db
    .update(mediaAssets)
    .set({
      status: "failed",
      error: "The server stopped before the clips were joined. Join them again.",
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(mediaAssets.source, "render"),
        eq(mediaAssets.status, "pending"),
        lt(mediaAssets.createdAt, new Date(now.getTime() - maxAgeMs)),
      ),
    )
    .returning()
    .all();
}

export interface WaitResult extends RefreshResult {
  /** True when the wait ended before the video was finished. */
  gaveUp?: "timeout" | "cancelled" | "errors";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for a video, asking the provider every few seconds. Used by project
 * runs. Gives up, leaving the asset pending, when the time is over, when the
 * run is cancelled, or when the provider cannot be asked several times in a
 * row; the video can still finish later from the Studio page.
 */
export async function waitForVideo(
  assetId: string,
  opts: {
    timeoutMs: number;
    isCancelled?: () => boolean;
    onTick?: (elapsedMs: number) => void;
    /** Milliseconds between checks, by elapsed time. For tests of callers. */
    intervalMs?: (elapsedMs: number) => number;
  },
): Promise<WaitResult> {
  const started = Date.now();
  const interval = opts.intervalMs ?? ((elapsed: number) => (elapsed < 120_000 ? 5_000 : 10_000));
  let consecutiveErrors = 0;
  let last = await refreshVideo(assetId);

  for (;;) {
    if (last.asset.status !== "pending") return last;
    if (last.checkError) {
      consecutiveErrors++;
      if (consecutiveErrors >= 5) return { ...last, gaveUp: "errors" };
    } else {
      consecutiveErrors = 0;
    }
    const elapsed = Date.now() - started;
    if (opts.isCancelled?.()) return { ...last, gaveUp: "cancelled" };
    if (elapsed >= opts.timeoutMs) return { ...last, gaveUp: "timeout" };
    opts.onTick?.(elapsed);
    await sleep(Math.min(interval(elapsed), Math.max(250, opts.timeoutMs - elapsed)));
    if (opts.isCancelled?.()) return { ...last, gaveUp: "cancelled" };
    last = await refreshVideo(assetId, { force: true });
  }
}

// ─── Library ─────────────────────────────────────────────────────────────────

/** Load an asset its owner or an administrator may see, or throw. */
export function loadOwnedAsset(assetId: string, user: User): MediaAsset {
  const asset = loadAsset(assetId);
  if (!asset) throw Errors.notFound("Media not found");
  if (asset.userId !== user.id && !isAdminRole(user.role)) throw Errors.forbidden();
  return asset;
}

export interface ListAssetsOptions {
  /** Whose media. Omit (administrators only) for everyone's. */
  userId?: string;
  kind?: MediaKind;
  projectId?: string;
  limit?: number;
  offset?: number;
}

export interface ListedAsset {
  asset: MediaAsset;
  owner: string | null;
}

/** Newest first. */
export function listAssets(opts: ListAssetsOptions = {}): ListedAsset[] {
  const where = and(
    opts.userId ? eq(mediaAssets.userId, opts.userId) : undefined,
    opts.kind ? eq(mediaAssets.kind, opts.kind) : undefined,
    opts.projectId ? eq(mediaAssets.projectId, opts.projectId) : undefined,
  );
  const limit = Math.min(Math.max(1, opts.limit ?? 60), 200);
  return db
    .select({ asset: mediaAssets, owner: users.username })
    .from(mediaAssets)
    .leftJoin(users, eq(mediaAssets.userId, users.id))
    .where(where)
    .orderBy(desc(mediaAssets.createdAt), desc(mediaAssets.id))
    .limit(limit)
    .offset(Math.max(0, opts.offset ?? 0))
    .all();
}

/** The media a project's runs produced, oldest first. */
export function assetsForProject(projectId: string): MediaAsset[] {
  return db
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.projectId, projectId))
    .orderBy(asc(mediaAssets.createdAt), asc(mediaAssets.id))
    .all();
}

// ─── Speech ──────────────────────────────────────────────────────────────────

export interface GenerateSpeechInput {
  userId: string | null;
  modelRowId: string;
  /** What is spoken. */
  text: string;
  voice?: string;
  format?: SpeechFormat;
  speed?: number;
  /** How to speak, for models that take such a hint. */
  instructions?: string;
  projectId?: string | null;
  taskId?: string | null;
}

/** Length of stored speech, when it can be told without much work. */
async function speechSeconds(file: StoredFile, bytes: Uint8Array): Promise<number | null> {
  if (file.mimeType === "audio/wav") {
    const seconds = wavDurationSeconds(bytes);
    if (seconds !== null) return seconds;
  }
  // Other formats need ffmpeg. It is not asked for here if it is not known to be there.
  if (!ffmpegStatusNow()?.available) return null;
  const path = mediaFilePath(file.fileName);
  return (await probeFile(path, inputFormat(path)))?.durationSeconds ?? null;
}

/** Generate speech from text and store it. Resolves to the new asset, `ready`. */
export async function generateSpeech(input: GenerateSpeechInput): Promise<MediaAsset> {
  const text = input.text.trim();
  if (!text) throw Errors.badRequest("Enter the text to speak");
  if (text.length > MAX_SPEECH_CHARS) {
    throw Errors.badRequest(`One request can speak at most ${MAX_SPEECH_CHARS} characters`);
  }
  assertTokensLeft(input.userId, input.projectId ? "project" : "yours");
  const resolved = resolveMediaModel(input.modelRowId, "audio");
  const adapter = getAdapter(resolved.provider.adapter);
  const started = Date.now();
  const id = randomUUID();
  let stored: StoredFile | null = null;
  let committed = false;

  try {
    const result = await adapter.generateSpeech!(
      contextFor(resolved.provider),
      {
        model: resolved.model.modelId,
        input: text,
        voice: input.voice,
        format: input.format,
        speed: input.speed,
        instructions: input.instructions,
      },
      { timeoutMs: Math.max(resolved.provider.timeoutMs, SPEECH_TIMEOUT_MS) },
    );
    if (result.bytes.byteLength === 0) {
      throw new AppError(502, "upstream_error", "The provider answered without audio");
    }
    // Bare samples are no file a player opens: give them a WAV header.
    const bytes: Uint8Array = result.pcm ? pcmToWav(result.bytes, result.pcm) : result.bytes;
    stored = await saveMediaBytes(id, "audio", bytes);
    const seconds = await speechSeconds(stored, bytes).catch(() => null);
    const cost = computeSpeechCost(resolved.model, text.length);
    const now = new Date();
    const asset = db
      .insert(mediaAssets)
      .values({
        id,
        userId: input.userId,
        projectId: input.projectId ?? null,
        taskId: input.taskId ?? null,
        kind: "audio",
        status: "ready",
        providerId: resolved.provider.id,
        modelRowId: resolved.model.id,
        modelLabel: modelLabel(resolved),
        apiKeyId: currentApiKeyId(),
        prompt: text,
        params: optionsJson({ voice: input.voice, speed: input.speed }),
        fileName: stored.fileName,
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
        durationSeconds: seconds,
        estimatedCost: cost,
        createdAt: now,
        updatedAt: now,
        completedAt: now,
      })
      .returning()
      .get();
    committed = true;
    recordUsage({
      userId: input.userId,
      providerId: resolved.provider.id,
      modelRowId: resolved.model.id,
      kind: "speech",
      // The text that was spoken is what was sent.
      promptTokens: estimateTokens(text),
      estimatedCost: cost,
      status: "ok",
      latencyMs: Date.now() - started,
    });
    markVerified(resolved.model.id, "audio");
    return asset;
  } catch (err) {
    if (committed) throw err;
    if (stored) await deleteMediaFile(stored.fileName);
    const safe = toAppError(err);
    recordUsage({
      userId: input.userId,
      providerId: resolved.provider.id,
      modelRowId: resolved.model.id,
      kind: "speech",
      status: "error",
      errorCode: safe.code,
      latencyMs: Date.now() - started,
    });
    throw safe;
  }
}

// ─── Uploads ─────────────────────────────────────────────────────────────────

/**
 * Store a picture a user uploaded, to start a video from or to use as a still
 * when clips are joined. The type is read from the file's own bytes, as for
 * everything else that is stored.
 */
export async function storeUploadedImage(input: {
  userId: string;
  bytes: Buffer;
  name: string;
}): Promise<MediaAsset> {
  if (input.bytes.byteLength === 0) throw Errors.badRequest("The file is empty");
  if (input.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw Errors.badRequest(`An image can be at most ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB`);
  }
  const type = sniffMedia(input.bytes.subarray(0, 16));
  if (!type || type.kind !== "image") {
    throw Errors.badRequest("Upload a PNG, JPEG, GIF or WebP image");
  }
  const id = randomUUID();
  let file: StoredFile;
  try {
    file = await saveMediaBytes(id, "image", input.bytes);
  } catch (err) {
    throw toAppError(err);
  }
  const now = new Date();
  const label = input.name.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200) || "Uploaded image";
  return db
    .insert(mediaAssets)
    .values({
      id,
      userId: input.userId,
      kind: "image",
      source: "upload",
      status: "ready",
      modelLabel: "Uploaded",
      prompt: label,
      fileName: file.fileName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    })
    .returning()
    .get();
}

/** Remove an asset and its file. A video still in progress is abandoned. */
export async function deleteAsset(asset: MediaAsset): Promise<void> {
  db.delete(mediaAssets).where(eq(mediaAssets.id, asset.id)).run();
  await deleteMediaFile(asset.fileName);
}
