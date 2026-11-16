/**
 * Helpers for creative tasks (image, video, voice-over, joined video). Pure,
 * so they can be unit-tested.
 */
import { MAX_MEDIA_PROMPT_CHARS } from "../adapters/media-protocol";

/**
 * What a project task delivers: written text, a generated image, video or
 * voice-over, or (`render`) one video joined from the clips of earlier tasks.
 */
export const TASK_KINDS = ["text", "image", "video", "audio", "render"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** The kinds a model generates from a prompt the agent writes. */
export const GENERATED_KINDS = ["image", "video", "audio"] as const;
export type GeneratedKind = (typeof GENERATED_KINDS)[number];

export function isGeneratedKind(kind: string): kind is GeneratedKind {
  return (GENERATED_KINDS as readonly string[]).includes(kind);
}

/** Most images, videos and voice-overs a project may be set to generate in one run. */
export const MAX_MEDIA_PER_RUN = 40;
/** What a new project is set to. */
export const DEFAULT_MAX_MEDIA = 10;

export interface MediaOptions {
  aspectRatio?: string;
  durationSeconds?: number;
  resolution?: string;
  size?: string;
  /** Speech: the voice, as the provider names it. */
  voice?: string;
  /** Speech: 1 is normal speed. */
  speed?: number;
  /**
   * A video task: the number of the image task whose picture the clip starts
   * from (image-to-video).
   */
  imageFrom?: number;
  /** A stored video: the image asset it started from. */
  imageAssetId?: string;
  /** Joining clips: burn the voice-over text in as subtitles. */
  subtitles?: boolean;
  /** Joining clips: keep the sound the clips came with. */
  keepClipAudio?: boolean;
  /** Joining clips: fill the frame ("cover") or show the whole clip ("contain"). */
  fit?: "contain" | "cover";
}

export const VOICE_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._:-]{0,63}$/u;
export const MIN_SPEECH_SPEED = 0.25;
export const MAX_SPEECH_SPEED = 4;
/** Longest text one speech request may speak. */
export const MAX_SPEECH_CHARS = 4096;

const QUOTE_PAIRS: Record<string, string> = {
  '"': '"',
  "'": "'",
  "`": "`",
  "“": "”",
  "‘": "’",
};

/**
 * Turn an agent's reply into the prompt sent to the image / video model.
 * Agents are asked for the prompt alone, but models often wrap it: a code
 * fence, a lead-in line, a "Prompt:" label, surrounding quotes. Those are
 * removed, whitespace is collapsed, and the result is cut to the length
 * providers accept.
 */
export function cleanMediaPrompt(raw: string, max: number = MAX_MEDIA_PROMPT_CHARS): string {
  let text = raw.trim();

  // A fenced block: keep what is inside the first one.
  const fence = text.match(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/);
  if (fence && fence[1]!.trim()) text = fence[1]!.trim();

  // A short lead-in line ending in a colon ("Here is the prompt:").
  const leadIn = text.match(/^[^\n]{0,80}[:：][ \t]*\n+([\s\S]+)$/);
  if (leadIn && leadIn[1]!.trim()) text = leadIn[1]!.trim();

  // A leading label, with or without markdown emphasis.
  text = text.replace(
    /^(\*\*|__)?\s*(image |video |final )?prompt\s*(\*\*|__)?\s*(?:[:：]|\s[-–—]\s)\s*(\*\*|__)?\s*/i,
    "",
  );

  // One pair of quotes around the whole text, and none inside it.
  const open = text[0];
  const close = open ? QUOTE_PAIRS[open] : undefined;
  if (open && close && text.length > 2 && text.endsWith(close)) {
    const inner = text.slice(1, -1);
    if (inner.trim() && !inner.includes(open) && !inner.includes(close)) text = inner;
  }

  text = text.replace(/\s+/g, " ").trim();
  if (text.length > max) text = text.slice(0, max).trimEnd();
  return text;
}

/**
 * What a media task leaves as its written artifact. Later tasks, the final
 * synthesis and the reviewer read this text; none of them can see the media
 * itself, and the text says so.
 */
export function mediaArtifact(input: {
  kind: GeneratedKind;
  assetId: string;
  /** The model that made it. Empty when the text is not to say which. */
  modelLabel: string;
  prompt: string;
  options?: MediaOptions;
}): string {
  const by = input.modelLabel ? ` with ${input.modelLabel}` : "";
  if (input.kind === "audio") {
    return (
      `Generated voice-over${by}` +
      (input.options?.voice ? ` (voice ${input.options.voice})` : "") +
      `. Asset ${input.assetId}.\n` +
      "The audio itself is not audible to other agents; this is the text that is spoken:\n" +
      input.prompt
    );
  }
  const details = [
    input.options?.aspectRatio,
    input.kind === "video" && input.options?.durationSeconds
      ? `${input.options.durationSeconds}s`
      : null,
    input.options?.resolution,
    input.options?.size,
    input.kind === "video" && input.options?.imageAssetId ? "starting from an image" : null,
  ].filter(Boolean);
  return (
    `Generated ${input.kind}${by}` +
    (details.length ? ` (${details.join(", ")})` : "") +
    `. Asset ${input.assetId}.\n` +
    `The ${input.kind} itself is not visible to other agents; this is the prompt it was generated from:\n` +
    input.prompt
  );
}

/** What a render task leaves as its written artifact. */
export function renderArtifact(input: {
  assetId: string;
  clips: number;
  voiceOvers: number;
  subtitles: boolean;
  durationSeconds: number | null;
}): string {
  const parts = [`${input.clips} ${input.clips === 1 ? "clip" : "clips"}`];
  if (input.voiceOvers > 0) parts.push(input.subtitles ? "voice-over and subtitles" : "voice-over");
  return (
    `Joined video from ${parts.join(", with ")}` +
    (input.durationSeconds ? ` (${Math.round(input.durationSeconds)}s)` : "") +
    `. Asset ${input.assetId}.\n` +
    "The video itself is not visible to other agents. It was put together on this server from the " +
    "clips and voice-overs of earlier tasks, in task order."
  );
}

/**
 * Turn an agent's reply into the text a speech model speaks. As with a media
 * prompt, wrappers are removed; unlike it, the text keeps its sentences and
 * loses what a voice would read out by mistake: markdown marks, stage
 * directions on their own line, speaker labels.
 */
export function cleanSpeechText(raw: string, max: number = MAX_SPEECH_CHARS): string {
  let text = raw.trim();
  const fence = text.match(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/);
  if (fence && fence[1]!.trim()) text = fence[1]!.trim();
  const leadIn = text.match(/^[^\n]{0,80}[:：][ \t]*\n+([\s\S]+)$/);
  if (leadIn && leadIn[1]!.trim()) text = leadIn[1]!.trim();

  const lines = text
    .split(/\r?\n/)
    .map((line) =>
      line
        // Headings, list marks, quote marks.
        .replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+|>\s?|\d{1,2}[.)]\s+)/, "")
        // A speaker or scene label in front of what is said.
        .replace(/^(\*\*|__)?\s*(voice[- ]?over|narrat(or|ion)|vo|speaker|scene\s*\d+|script)\s*(\*\*|__)?\s*[:：-]\s*(\*\*|__)?\s*/i, "")
        .replace(/(\*\*|__|\*|_|`)/g, "")
        .trim(),
    )
    // A line that is only a direction: (pause), [music fades].
    .filter((line) => line && !/^[([][^)\]]*[)\]]$/.test(line));
  text = lines.join(" ").replace(/\s+/g, " ").trim();

  const open = text[0];
  const close = open ? QUOTE_PAIRS[open] : undefined;
  if (open && close && text.length > 2 && text.endsWith(close)) {
    const inner = text.slice(1, -1);
    if (inner.trim() && !inner.includes(open) && !inner.includes(close)) text = inner.trim();
  }
  if (text.length > max) {
    // End on a whole sentence where that keeps most of the text.
    const cut = text.slice(0, max);
    const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    text = stop > max * 0.6 ? cut.slice(0, stop + 1) : cut.trimEnd();
  }
  return text;
}

/** Parse the JSON stored in `project_tasks.media_options`. Never throws. */
export function parseMediaOptions(raw: string | null | undefined): MediaOptions {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const v = value as Record<string, unknown>;
    const out: MediaOptions = {};
    if (typeof v.aspectRatio === "string") out.aspectRatio = v.aspectRatio;
    if (typeof v.durationSeconds === "number" && v.durationSeconds > 0) {
      out.durationSeconds = v.durationSeconds;
    }
    if (typeof v.resolution === "string") out.resolution = v.resolution;
    if (typeof v.size === "string") out.size = v.size;
    if (typeof v.voice === "string" && v.voice) out.voice = v.voice;
    if (typeof v.speed === "number" && v.speed > 0) out.speed = v.speed;
    if (typeof v.imageFrom === "number" && Number.isInteger(v.imageFrom) && v.imageFrom > 0) {
      out.imageFrom = v.imageFrom;
    }
    if (typeof v.imageAssetId === "string" && v.imageAssetId) out.imageAssetId = v.imageAssetId;
    if (typeof v.subtitles === "boolean") out.subtitles = v.subtitles;
    if (typeof v.keepClipAudio === "boolean") out.keepClipAudio = v.keepClipAudio;
    if (v.fit === "contain" || v.fit === "cover") out.fit = v.fit;
    return out;
  } catch {
    return {};
  }
}
