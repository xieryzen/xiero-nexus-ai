import "server-only";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { jobs, mediaAssets, type MediaAsset } from "@/db/schema";
import { AppError, Errors, sanitizeUpstreamError } from "../errors";
import { serial } from "../runtime";
import { ffmpegStatus, probeFile, runFfmpeg } from "./ffmpeg";
import { fontFamilyName } from "./font";
import {
  DEFAULT_STILL_SECONDS,
  MAX_RENDER_CLIPS,
  MAX_RENDER_SECONDS,
  MAX_STILL_SECONDS,
  buildAss,
  buildRenderPlan,
  frameFor,
  frameForShape,
  inputFormat,
  type RenderClip,
  type RenderFit,
  type RenderNarration,
} from "./render-plan";
import { adoptMediaFile, deleteMediaFile, mediaFilePath, mediaTempPath } from "./store";

/**
 * Joining clips into one video, on this server, with ffmpeg.
 *
 * A render is a media asset like a generated video: it is created `pending`,
 * and becomes `ready` or `failed`. The background worker does the work for a
 * request from Creative Studio or the API; a project run does it itself.
 */

export const RENDER_LABEL = "Joined on this server";
const MAX_NARRATION = MAX_RENDER_CLIPS;

export interface RenderOptions {
  /** Image and video assets, in the order they are shown. */
  clipIds: string[];
  /** Audio assets laid over the clips. */
  narrationIds?: string[];
  aspectRatio?: string;
  fit?: RenderFit;
  subtitles?: boolean;
  keepClipAudio?: boolean;
  stillSeconds?: number;
}

export interface CreateRenderInput extends RenderOptions {
  userId: string | null;
  /** Shown as the asset's description. */
  title?: string;
  projectId?: string | null;
  taskId?: string | null;
}

/** What is stored in the asset's `params`, next to the aspect ratio. */
interface StoredRender {
  clipIds: string[];
  narrationIds: string[];
  fit: RenderFit;
  subtitles: boolean;
  keepClipAudio: boolean;
  stillSeconds: number;
}

function parseStoredRender(raw: string | null): { aspectRatio?: string; render: StoredRender } | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { aspectRatio?: unknown; render?: Partial<StoredRender> };
    const r = value.render;
    if (!r || !Array.isArray(r.clipIds)) return null;
    const ids = (list: unknown) =>
      Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : [];
    return {
      aspectRatio: typeof value.aspectRatio === "string" ? value.aspectRatio : undefined,
      render: {
        clipIds: ids(r.clipIds),
        narrationIds: ids(r.narrationIds),
        fit: r.fit === "cover" ? "cover" : "contain",
        subtitles: r.subtitles === true,
        keepClipAudio: r.keepClipAudio === true,
        stillSeconds:
          typeof r.stillSeconds === "number" && r.stillSeconds > 0 ? r.stillSeconds : DEFAULT_STILL_SECONDS,
      },
    };
  } catch {
    return null;
  }
}

function loadAssets(ids: string[]): Map<string, MediaAsset> {
  if (ids.length === 0) return new Map();
  const rows = db
    .select()
    .from(mediaAssets)
    .where(inArray(mediaAssets.id, [...new Set(ids)]))
    .all();
  return new Map(rows.map((a) => [a.id, a] as const));
}

/**
 * Check what is to be joined, without doing it. `mayUse` says whether the
 * requester may read an asset. Throws an error that names the problem.
 */
export function checkRenderInput(input: RenderOptions, mayUse: (asset: MediaAsset) => boolean): void {
  if (input.clipIds.length === 0) throw Errors.badRequest("Choose at least one clip to join");
  if (input.clipIds.length > MAX_RENDER_CLIPS) {
    throw Errors.badRequest(`At most ${MAX_RENDER_CLIPS} clips can be joined`);
  }
  const narrationIds = input.narrationIds ?? [];
  if (narrationIds.length > MAX_NARRATION) {
    throw Errors.badRequest(`At most ${MAX_NARRATION} voice-overs can be used`);
  }
  const assets = loadAssets([...input.clipIds, ...narrationIds]);
  const usable = (id: string, kinds: MediaAsset["kind"][], what: string): MediaAsset => {
    const asset = assets.get(id);
    // The same answer for a file that does not exist and one that is someone else's.
    if (!asset || !mayUse(asset)) throw Errors.badRequest(`A ${what} was not found`);
    if (!kinds.includes(asset.kind)) throw Errors.badRequest(`"${asset.prompt.slice(0, 40)}" cannot be used as a ${what}`);
    if (asset.status !== "ready" || !asset.fileName) {
      throw Errors.badRequest(`A ${what} is not finished yet`);
    }
    return asset;
  };
  for (const id of input.clipIds) usable(id, ["video", "image"], "clip");
  for (const id of narrationIds) usable(id, ["audio"], "voice-over");
}

function describe(input: CreateRenderInput): string {
  if (input.title?.trim()) return input.title.trim().slice(0, 500);
  const clips = input.clipIds.length;
  const voices = input.narrationIds?.length ?? 0;
  return (
    `Joined from ${clips} ${clips === 1 ? "clip" : "clips"}` +
    (voices > 0 ? (input.subtitles ? ", with voice-over and subtitles" : ", with voice-over") : "")
  );
}

/** Create the asset of a render, `pending`. `renderAsset` then makes the file. */
export function createRenderAsset(input: CreateRenderInput): MediaAsset {
  const stored: StoredRender = {
    clipIds: input.clipIds,
    narrationIds: input.narrationIds ?? [],
    fit: input.fit ?? "contain",
    subtitles: Boolean(input.subtitles),
    keepClipAudio: Boolean(input.keepClipAudio),
    stillSeconds: Math.min(Math.max(1, input.stillSeconds ?? DEFAULT_STILL_SECONDS), MAX_STILL_SECONDS),
  };
  const now = new Date();
  return db
    .insert(mediaAssets)
    .values({
      id: randomUUID(),
      userId: input.userId,
      projectId: input.projectId ?? null,
      taskId: input.taskId ?? null,
      kind: "video",
      source: "render",
      status: "pending",
      modelLabel: RENDER_LABEL,
      prompt: describe(input),
      params: JSON.stringify({
        ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
        render: stored,
      }),
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

/** Hand a pending render to the background worker. */
export function queueRender(asset: MediaAsset): void {
  db.insert(jobs)
    .values({ kind: "render", payload: JSON.stringify({ assetId: asset.id }), userId: asset.userId })
    .run();
}

function finish(assetId: string, values: Partial<MediaAsset>): MediaAsset | undefined {
  const now = new Date();
  return db
    .update(mediaAssets)
    .set({ ...values, completedAt: now, updatedAt: now, lastCheckedAt: now })
    .where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.status, "pending")))
    .returning()
    .get();
}

/** The font subtitles are drawn with: the administrator's, else the bundled one. */
async function subtitleFont(): Promise<{ file: string; name: string } | null> {
  const custom = process.env.SUBTITLE_FONT_FILE?.trim();
  if (custom) {
    try {
      const name = process.env.SUBTITLE_FONT_NAME?.trim() || fontFamilyName(await readFile(custom));
      if (name) return { file: custom, name };
      // eslint-disable-next-line no-console
      console.warn(
        "[xiero-nexus] SUBTITLE_FONT_FILE: the font's family name could not be read. Set SUBTITLE_FONT_NAME.",
      );
    } catch {
      // eslint-disable-next-line no-console
      console.warn("[xiero-nexus] SUBTITLE_FONT_FILE cannot be read; using the bundled font.");
    }
  }
  const bundled = join(process.cwd(), "assets", "fonts", "NotoSans-Bold.ttf");
  return existsSync(bundled) ? { file: bundled, name: "Noto Sans" } : null;
}

/** ffmpeg's own words, without this server's folders in them. */
function ffmpegError(stderr: string, hide: string[]): string {
  let text = stderr;
  for (const path of hide) if (path) text = text.split(path).join("");
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return sanitizeUpstreamError(lines.slice(-2).join(" ").slice(-300) || "no details");
}

async function render(asset: MediaAsset, isCancelled?: () => boolean): Promise<Partial<MediaAsset>> {
  const stored = parseStoredRender(asset.params);
  if (!stored) throw new AppError(400, "render_invalid", "The render request cannot be read");
  const { render: spec } = stored;

  const status = await ffmpegStatus();
  if (!status.available) {
    throw new AppError(
      400,
      "ffmpeg_missing",
      "Joining clips needs ffmpeg on the server. Install it, or set FFMPEG_PATH to the program.",
    );
  }
  if (!status.h264) {
    throw new AppError(400, "ffmpeg_missing", "This server's ffmpeg cannot encode H.264 (it has no libx264).");
  }

  const assets = loadAssets([...spec.clipIds, ...spec.narrationIds]);
  const fileOf = (id: string, what: string): { asset: MediaAsset; path: string } => {
    const item = assets.get(id);
    if (!item || item.status !== "ready" || !item.fileName) {
      throw new AppError(400, "render_input_missing", `A ${what} is no longer available`);
    }
    return { asset: item, path: mediaFilePath(item.fileName) };
  };

  const clips: RenderClip[] = [];
  let firstShape: { width: number; height: number } | null = null;
  for (const id of spec.clipIds) {
    const { asset: clip, path } = fileOf(id, "clip");
    const info = await probeFile(path, inputFormat(path));
    if (!info || !info.hasVideo) {
      throw new AppError(400, "render_input_unreadable", "ffmpeg could not read one of the clips");
    }
    if (clip.kind === "video" && !(info.durationSeconds && info.durationSeconds > 0)) {
      throw new AppError(400, "render_input_unreadable", "One of the clips has no readable length");
    }
    if (!firstShape && info.width && info.height) firstShape = { width: info.width, height: info.height };
    clips.push({
      file: path,
      type: clip.kind === "image" ? "image" : "video",
      durationSeconds: info.durationSeconds ?? 0,
      hasAudio: info.hasAudio,
    });
  }

  const narration: RenderNarration[] = [];
  for (const id of spec.narrationIds) {
    const { asset: voice, path } = fileOf(id, "voice-over");
    const info = await probeFile(path, inputFormat(path));
    if (!info || !info.hasAudio || !(info.durationSeconds && info.durationSeconds > 0)) {
      throw new AppError(400, "render_input_unreadable", "ffmpeg could not read one of the voice-overs");
    }
    narration.push({ file: path, durationSeconds: info.durationSeconds, text: voice.prompt });
  }

  // The frame: what was asked for, else the shape of the first clip.
  const frame = stored.aspectRatio
    ? frameFor(stored.aspectRatio)
    : firstShape
      ? frameForShape(firstShape.width, firstShape.height)
      : frameFor(undefined);

  const work = await mkdtemp(join(tmpdir(), "nexus-render-"));
  const output = await mediaTempPath(asset.id);
  try {
    let wantSubtitles = spec.subtitles && narration.length > 0 && status.subtitles;
    let fontName = "Sans";
    if (wantSubtitles) {
      const font = await subtitleFont();
      if (font) {
        await mkdir(join(work, "fonts"));
        await copyFile(font.file, join(work, "fonts", basename(font.file)));
        fontName = font.name;
      }
    }
    let plan;
    try {
      plan = buildRenderPlan({
        clips,
        narration,
        width: frame.width,
        height: frame.height,
        fit: spec.fit,
        stillSeconds: spec.stillSeconds,
        keepClipAudio: spec.keepClipAudio,
        subtitles: wantSubtitles,
        subtitleFile: "subs.ass",
        fontsDir: "fonts",
        output,
      });
    } catch (err) {
      throw new AppError(400, "render_invalid", err instanceof Error ? err.message : "Invalid render");
    }
    if (plan.captions.length > 0) {
      await mkdir(join(work, "fonts"), { recursive: true });
      await writeFile(
        join(work, "subs.ass"),
        buildAss(plan.captions, { width: frame.width, height: frame.height, fontName }),
        "utf8",
      );
    } else {
      wantSubtitles = false;
    }

    // Encoding takes a fraction of the result's length on a fast machine and
    // several times it on a small one.
    const timeoutMs = Math.min(60 * 60_000, 120_000 + plan.timeline.totalSeconds * 40_000);
    const result = await serial("ffmpeg-render", () =>
      runFfmpeg(plan.args, { cwd: work, timeoutMs, isCancelled }),
    );
    if (isCancelled?.()) throw new AppError(499, "cancelled", "Cancelled");
    if (result.timedOut) {
      throw new AppError(504, "render_timeout", "ffmpeg did not finish in time. The server may be too small for this video.");
    }
    if (result.code !== 0) {
      throw new AppError(
        500,
        "render_failed",
        `ffmpeg could not join the clips: ${ffmpegError(result.stderr, [work, dirname(output), tmpdir()])}`,
      );
    }
    const file = await adoptMediaFile(asset.id, "video");
    return {
      status: "ready",
      fileName: file.fileName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      durationSeconds: plan.timeline.totalSeconds,
      error:
        spec.subtitles && narration.length > 0 && !wantSubtitles
          ? "Made without subtitles: this server's ffmpeg cannot draw them."
          : null,
    };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    await rm(output, { force: true }).catch(() => undefined);
  }
}

/**
 * Make the file of a pending render. Resolves to the asset as it is
 * afterwards: `ready`, or `failed` with the reason. Never throws for a
 * problem with the render itself.
 */
export async function renderAsset(
  assetId: string,
  opts: { isCancelled?: () => boolean } = {},
): Promise<MediaAsset> {
  const asset = db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId)).get();
  if (!asset) throw Errors.notFound("Media not found");
  if (asset.source !== "render" || asset.status !== "pending") return asset;

  let values: Partial<MediaAsset>;
  try {
    values = await render(asset, opts.isCancelled);
  } catch (err) {
    if (!(err instanceof AppError)) {
      // eslint-disable-next-line no-console
      console.error("[xiero-nexus] render failed:", err);
    }
    values = {
      status: "failed",
      error:
        err instanceof AppError
          ? err.message
          : "Could not join the clips. Check the server log and the media folder.",
    };
  }
  const updated = finish(assetId, values);
  if (!updated) {
    // Deleted while ffmpeg was running: do not leave the file behind.
    if (values.fileName) await deleteMediaFile(values.fileName);
    return db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId)).get() ?? asset;
  }
  return updated;
}

/** Renders that were never finished and whose job is gone, for the worker to fail. */
export const RENDER_MAX_AGE_MS = 2 * 60 * 60_000;

export { MAX_RENDER_CLIPS, MAX_RENDER_SECONDS };
