import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq } from "drizzle-orm";
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
import type { MediaDownload, ProviderAdapter, ProviderContext } from "../adapters/types";
import { MEDIA_CAPABILITY } from "../capabilities";
import { parseMediaOptions, type MediaOptions } from "../creative/prompt";
import { AppError, Errors, sanitizeUpstreamError } from "../errors";
import { contextFor, resolveEnabledModel, type ResolvedModel } from "../gateway";
import { safeFetch } from "../http-client";
import { recordUsage } from "../usage";
import { computeImageCost, computeVideoCost } from "./cost";
import { MAX_IMAGE_BYTES, type MediaKind } from "./files";
import { readBodyCapped } from "./http";
import { deleteMediaFile, saveMediaBytes, saveMediaResponse, type StoredFile } from "./store";

/**
 * Image and video generation through the gateway.
 *
 * An image request waits for the provider and stores the files. A video is a
 * job: `startVideo` creates a `pending` asset, and `refreshVideo` asks the
 * provider about it and, once it is finished, downloads the file. Nothing runs
 * in the background: a pending video moves forward only when someone asks
 * about it (the Studio page, or a project run waiting for it).
 */

/** How long an image request may take until the provider answers. */
const IMAGE_TIMEOUT_MS = 180_000;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 60_000;
const VIDEO_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/** A provider is asked about one job at most this often. */
const VIDEO_MIN_POLL_INTERVAL_MS = 3_000;
/** A job that is still not finished after this long is given up on. */
export const VIDEO_JOB_MAX_AGE_MS = 60 * 60_000;
/** Videos one user may have in progress at a time. */
export const MAX_PENDING_VIDEOS_PER_USER = 12;
const MAX_REDIRECTS = 3;

// ─── Models ──────────────────────────────────────────────────────────────────

const KIND_NOUN: Record<MediaKind, string> = { image: "image", video: "video" };

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
  const able = kind === "image" ? adapter.generateImages : adapter.startVideo && adapter.getVideo;
  if (!able) {
    throw Errors.badRequest(
      `The ${adapter.label} adapter cannot generate ${KIND_NOUN[kind]}s. Use a provider with the OpenAI-compatible adapter.`,
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
      promptTokens: parsed.inputTokens ?? 0,
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
  const resolved = resolveMediaModel(input.modelRowId, "video");
  const adapter = getAdapter(resolved.provider.adapter);
  const started = Date.now();

  let job: ParsedVideoJob;
  try {
    const ctx = contextFor(resolved.provider);
    job = await adapter.startVideo!(ctx, {
      model: resolved.model.modelId,
      prompt: input.prompt,
      durationSeconds: input.durationSeconds,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      size: input.size,
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
      prompt: input.prompt,
      params: optionsJson({
        aspectRatio: input.aspectRatio,
        durationSeconds: input.durationSeconds,
        resolution: input.resolution,
        size: input.size,
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
    kind: "video",
    status: "error",
    errorCode,
    latencyMs: now.getTime() - asset.createdAt.getTime(),
  });
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
    kind: "video",
    estimatedCost: cost,
    status: "ok",
    latencyMs: now.getTime() - asset.createdAt.getTime(),
  });
  if (asset.modelRowId) markVerified(asset.modelRowId, "video");
  return { asset: updated };
}

/** One refresh per asset at a time, shared by everyone who asks meanwhile. */
const refreshing = new Map<string, Promise<RefreshResult>>();

/**
 * Ask the provider about a pending video and, when it is finished, download
 * it. Safe to call often and from several places at once: calls are shared
 * while one is running, and the provider is not asked more than once every
 * few seconds. Anything that is not a pending video is returned as it is.
 */
export async function refreshVideo(
  assetId: string,
  opts: { force?: boolean } = {},
): Promise<RefreshResult> {
  const running = refreshing.get(assetId);
  if (running) return running;

  const asset = loadAsset(assetId);
  if (!asset) throw Errors.notFound("Media not found");
  if (asset.kind !== "video" || asset.status !== "pending") return { asset };
  if (
    !opts.force &&
    asset.lastCheckedAt &&
    Date.now() - asset.lastCheckedAt.getTime() < VIDEO_MIN_POLL_INTERVAL_MS
  ) {
    return { asset };
  }

  const work = refreshNow(asset).finally(() => refreshing.delete(assetId));
  refreshing.set(assetId, work);
  return work;
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
  if (asset.userId !== user.id && user.role !== "admin") throw Errors.forbidden();
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

/** Remove an asset and its file. A video still in progress is abandoned. */
export async function deleteAsset(asset: MediaAsset): Promise<void> {
  db.delete(mediaAssets).where(eq(mediaAssets.id, asset.id)).run();
  await deleteMediaFile(asset.fileName);
}
