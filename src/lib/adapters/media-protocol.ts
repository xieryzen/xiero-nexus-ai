/**
 * Image and video generation wire formats for OpenAI-compatible providers.
 *
 * Pure and dependency-free: it builds request bodies and parses responses,
 * nothing else. That keeps it unit-testable without a network or a database,
 * and safe to import from the schema and from client components.
 *
 * There is no single standard for media the way there is for chat. Three
 * request styles are in use, and a provider speaks exactly one of them:
 *
 *   style        images                                videos
 *   ──────────   ───────────────────────────────────   ─────────────────────────────────────
 *   openai       POST /images/generations              POST /videos
 *                size                                  seconds, size
 *                                                      result: GET /videos/{id}/content
 *   openrouter   POST /images                          POST /videos
 *                aspect_ratio, resolution, size        duration, aspect_ratio, resolution, size
 *                                                      result: unsigned_urls[] (needs the key)
 *   xai          POST /images/generations              POST /videos/generations
 *                aspect_ratio, resolution              duration, aspect_ratio, resolution
 *                                                      result: video.url (temporary link)
 *
 * A video is always a job: create it, read GET /videos/{id} until it is done,
 * then download the file. Responses are parsed leniently, so one parser covers
 * all three styles.
 */

export const MEDIA_APIS = ["openai", "openrouter", "xai"] as const;
export type MediaApi = (typeof MEDIA_APIS)[number];

/** What a provider can be set to. `auto` decides from the Base URL host. */
export const MEDIA_API_SETTINGS = ["auto", ...MEDIA_APIS] as const;
export type MediaApiSetting = (typeof MEDIA_API_SETTINGS)[number];

export const MEDIA_API_LABELS: Record<MediaApiSetting, string> = {
  auto: "Auto (from the Base URL)",
  openai: "OpenAI-style",
  openrouter: "OpenRouter",
  xai: "xAI",
};

/** Aspect ratios offered in the dashboard. Others can be typed in a workflow. */
export const ASPECT_RATIOS = ["1:1", "9:16", "16:9", "3:4", "4:3", "2:3", "3:2"] as const;

export const ASPECT_RATIO_PATTERN = /^\d{1,2}(\.\d)?:\d{1,2}(\.\d)?$/;
export const RESOLUTION_PATTERN = /^[A-Za-z0-9.]{1,8}$/;
export const SIZE_PATTERN = /^(auto|\d{2,5}x\d{2,5})$/;

export const MAX_MEDIA_PROMPT_CHARS = 4000;
export const MAX_IMAGES_PER_REQUEST = 4;
export const MAX_VIDEO_SECONDS = 60;

function hostOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Guess the media style from the provider's Base URL host. */
export function detectMediaApi(baseUrl: string): MediaApi {
  const host = hostOf(baseUrl);
  if (!host) return "openai";
  if (host === "x.ai" || host.endsWith(".x.ai")) return "xai";
  if (host === "openrouter.ai" || host.endsWith(".openrouter.ai")) return "openrouter";
  return "openai";
}

/** The style to use: the provider's explicit setting, else the guess. */
export function resolveMediaApi(
  setting: string | null | undefined,
  baseUrl: string,
): MediaApi {
  return (MEDIA_APIS as readonly string[]).includes(setting ?? "")
    ? (setting as MediaApi)
    : detectMediaApi(baseUrl);
}

// ─── Requests ────────────────────────────────────────────────────────────────

export interface ImageRequest {
  model: string;
  prompt: string;
  /** Number of images. 1 is not sent: it is every provider's default. */
  n?: number;
  aspectRatio?: string;
  /** Quality tier such as "1k" or "2K" (openrouter and xai styles). */
  resolution?: string;
  /** Exact "WIDTHxHEIGHT" (openai and openrouter styles). */
  size?: string;
  /** Provider-specific parameters, sent as given. */
  extra?: Record<string, unknown>;
}

export interface VideoRequest {
  model: string;
  prompt: string;
  durationSeconds?: number;
  aspectRatio?: string;
  /** "480p", "720p", "1080p", … */
  resolution?: string;
  /** Exact "WIDTHxHEIGHT" (openai and openrouter styles). */
  size?: string;
  extra?: Record<string, unknown>;
}

export interface WireRequest {
  /** Path below the provider's Base URL, starting with "/". */
  path: string;
  body: Record<string, unknown>;
}

/** Keys the gateway owns. `stream` would change the response into SSE. */
const RESERVED_EXTRA_KEYS = new Set(["model", "prompt", "stream"]);

function cleanExtra(extra: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return out;
  for (const [key, value] of Object.entries(extra)) {
    if (RESERVED_EXTRA_KEYS.has(key) || value === undefined) continue;
    out[key] = value;
  }
  return out;
}

export type Orientation = "square" | "portrait" | "landscape";

function ratioParts(aspectRatio: string | undefined): [number, number] | null {
  if (!aspectRatio || !ASPECT_RATIO_PATTERN.test(aspectRatio)) return null;
  const [w, h] = aspectRatio.split(":").map(Number) as [number, number];
  if (!(w > 0) || !(h > 0)) return null;
  return [w, h];
}

export function orientationOf(aspectRatio: string | undefined): Orientation | null {
  const parts = ratioParts(aspectRatio);
  if (!parts) return null;
  const [w, h] = parts;
  return w === h ? "square" : w < h ? "portrait" : "landscape";
}

/**
 * The OpenAI-style image `size` for an aspect ratio. Only the three sizes
 * every such model accepts are used, so 9:16 becomes the 2:3 portrait size.
 * Pass an explicit size for models that take arbitrary dimensions.
 */
export function imageSizeFor(aspectRatio: string | undefined): string | undefined {
  switch (orientationOf(aspectRatio)) {
    case "square":
      return "1024x1024";
    case "portrait":
      return "1024x1536";
    case "landscape":
      return "1536x1024";
    default:
      return undefined;
  }
}

/** Round to the nearest even number: video encoders need even dimensions. */
function even(n: number): number {
  return Math.round(n / 2) * 2;
}

/**
 * The OpenAI-style video `size` for an aspect ratio and a resolution such as
 * "720p", which names the short side. 9:16 at 720p is 720x1280.
 */
export function videoSizeFor(
  aspectRatio: string | undefined,
  resolution: string | undefined,
): string | undefined {
  const parts = ratioParts(aspectRatio);
  if (!parts) return undefined;
  const [w, h] = parts;
  const match = resolution?.match(/^(\d{3,4})p$/i);
  const short = match ? Number(match[1]) : 720;
  if (w === h) return `${short}x${short}`;
  return w < h ? `${short}x${even((short * h) / w)}` : `${even((short * w) / h)}x${short}`;
}

export function buildImageRequest(api: MediaApi, req: ImageRequest): WireRequest {
  const body: Record<string, unknown> = {
    ...cleanExtra(req.extra),
    model: req.model,
    prompt: req.prompt,
  };
  if (req.n && req.n > 1) body.n = req.n;

  switch (api) {
    case "openai": {
      const size = req.size ?? imageSizeFor(req.aspectRatio);
      if (size) body.size = size;
      return { path: "/images/generations", body };
    }
    case "openrouter": {
      // An exact size is authoritative there and must not be combined with
      // an aspect ratio or a resolution.
      if (req.size) {
        body.size = req.size;
      } else {
        if (req.aspectRatio) body.aspect_ratio = req.aspectRatio;
        if (req.resolution) body.resolution = req.resolution;
      }
      return { path: "/images", body };
    }
    case "xai": {
      if (req.aspectRatio) body.aspect_ratio = req.aspectRatio;
      if (req.resolution) body.resolution = req.resolution;
      // The default there is a temporary link; ask for the bytes instead.
      if (body.response_format === undefined) body.response_format = "b64_json";
      return { path: "/images/generations", body };
    }
  }
}

export function buildVideoRequest(api: MediaApi, req: VideoRequest): WireRequest {
  const body: Record<string, unknown> = {
    ...cleanExtra(req.extra),
    model: req.model,
    prompt: req.prompt,
  };
  const seconds = req.durationSeconds && req.durationSeconds > 0 ? req.durationSeconds : null;

  switch (api) {
    case "openai": {
      if (seconds) body.seconds = String(seconds);
      const size = req.size ?? videoSizeFor(req.aspectRatio, req.resolution);
      if (size) body.size = size;
      return { path: "/videos", body };
    }
    case "openrouter": {
      if (seconds) body.duration = seconds;
      if (req.size) {
        body.size = req.size;
      } else {
        if (req.aspectRatio) body.aspect_ratio = req.aspectRatio;
        if (req.resolution) body.resolution = req.resolution;
      }
      return { path: "/videos", body };
    }
    case "xai": {
      if (seconds) body.duration = seconds;
      if (req.aspectRatio) body.aspect_ratio = req.aspectRatio;
      if (req.resolution) body.resolution = req.resolution;
      return { path: "/videos/generations", body };
    }
  }
}

// ─── Responses ───────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

/** A provider's error payload as one line, or undefined when there is none. */
export function upstreamErrorText(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const err = payload.error;
  if (typeof err === "string") return str(err);
  if (isRecord(err)) return str(err.message) ?? str(err.code);
  return undefined;
}

export interface ParsedImage {
  /** Base64 image bytes, when the provider returned them inline. */
  b64?: string;
  /** A link to fetch instead. */
  url?: string;
}

export interface ParsedImageResponse {
  images: ParsedImage[];
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
}

const DATA_URL = /^data:[^;,]*;base64,(.+)$/s;

export function parseImageResponse(payload: unknown): ParsedImageResponse {
  const out: ParsedImageResponse = { images: [] };
  if (!isRecord(payload)) return out;

  const data = Array.isArray(payload.data) ? payload.data : [];
  for (const item of data) {
    if (!isRecord(item)) continue;
    const b64 = str(item.b64_json);
    if (b64) {
      out.images.push({ b64 });
      continue;
    }
    const url = str(item.url);
    if (!url) continue;
    const inline = url.match(DATA_URL);
    out.images.push(inline ? { b64: inline[1]! } : { url });
  }

  if (isRecord(payload.usage)) {
    out.inputTokens = num(payload.usage.input_tokens) ?? num(payload.usage.prompt_tokens);
    out.outputTokens = num(payload.usage.output_tokens) ?? num(payload.usage.completion_tokens);
  }
  out.error = upstreamErrorText(payload);
  return out;
}

export type VideoState = "pending" | "done" | "failed";

export interface ParsedVideoJob {
  /** The provider's job id, from `id` or `request_id`. */
  id: string | null;
  state: VideoState;
  /** Why it failed, when it did. */
  error?: string;
  /** Links to the finished file, best first. May be relative. */
  urls: string[];
  /** Length of the finished clip, when the provider reports it. */
  durationSeconds?: number;
}

const PENDING_STATES = new Set(["queued", "pending", "in_progress", "processing", "running", "starting", "created", "submitted"]);
const DONE_STATES = new Set(["completed", "complete", "done", "succeeded", "success", "finished"]);
const FAILED_STATES = new Set(["failed", "error", "cancelled", "canceled", "expired", "rejected"]);

/** A job id is put into a URL path, so it must be one plain token. */
export function isValidJobId(id: unknown): id is string {
  return typeof id === "string" && /^[\x21-\x7E]{1,300}$/.test(id) && id !== "." && id !== "..";
}

export function parseVideoJob(payload: unknown): ParsedVideoJob {
  const job: ParsedVideoJob = { id: null, state: "pending", urls: [] };
  if (!isRecord(payload)) return job;

  const id = str(payload.id) ?? str(payload.request_id);
  job.id = isValidJobId(id) ? id : null;

  const video = isRecord(payload.video) ? payload.video : null;
  const pushUrl = (value: unknown) => {
    const url = str(value);
    if (url && !job.urls.includes(url)) job.urls.push(url);
  };
  // Best first: a direct link, then links that need the key, then signed ones.
  pushUrl(video?.url);
  if (Array.isArray(payload.unsigned_urls)) payload.unsigned_urls.forEach(pushUrl);
  if (Array.isArray(payload.urls)) payload.urls.forEach(pushUrl);
  pushUrl(payload.url);

  job.durationSeconds = num(video?.duration) ?? num(payload.seconds) ?? num(payload.duration);

  const status = str(payload.status)?.toLowerCase();
  if (status && FAILED_STATES.has(status)) job.state = "failed";
  else if (status && DONE_STATES.has(status)) job.state = "done";
  else if (status && PENDING_STATES.has(status)) job.state = "pending";
  // No status, or one we do not know: a file link means it is finished.
  else job.state = job.urls.length > 0 ? "done" : "pending";

  if (job.state === "failed") {
    job.error =
      upstreamErrorText(payload) ?? `The provider reported the video as ${status ?? "failed"}`;
  }
  return job;
}

export function videoStatusPath(jobId: string): string {
  return `/videos/${encodeURIComponent(jobId)}`;
}

export function videoContentPath(jobId: string): string {
  return `/videos/${encodeURIComponent(jobId)}/content`;
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export interface DownloadPlan {
  url: string;
  /**
   * Whether to send the provider's credentials. True only for the provider's
   * own origin: a link to anywhere else is fetched without them, so a response
   * can never direct the key to another host.
   */
  withAuth: boolean;
}

/**
 * How to fetch a link a provider returned (it may be relative), or null when
 * it is not an http(s) link.
 */
export function linkDownloadPlan(baseUrl: string, link: string): DownloadPlan | null {
  let origin: string | null = null;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    origin = null;
  }
  let url: URL;
  try {
    url = new URL(link, baseUrl); // resolves relative links
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return { url: url.toString(), withAuth: origin !== null && url.origin === origin };
}

/** Where to fetch a finished video from, and whether that needs the key. */
export function videoDownloadPlan(
  baseUrl: string,
  jobId: string,
  job: Pick<ParsedVideoJob, "urls">,
): DownloadPlan {
  for (const candidate of job.urls) {
    const plan = linkDownloadPlan(baseUrl, candidate);
    if (plan) return plan;
  }
  return { url: `${trimBase(baseUrl)}${videoContentPath(jobId)}`, withAuth: true };
}
