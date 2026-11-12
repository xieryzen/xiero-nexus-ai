/**
 * Helpers for creative (image / video) tasks. Pure, so they can be unit-tested.
 */
import { MAX_MEDIA_PROMPT_CHARS } from "../adapters/media-protocol";

/** What a project task delivers: written text, or a generated image / video. */
export const TASK_KINDS = ["text", "image", "video"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** Most images + videos a project may be set to generate in one run. */
export const MAX_MEDIA_PER_RUN = 24;
/** What a new project is set to. */
export const DEFAULT_MAX_MEDIA = 10;

export interface MediaOptions {
  aspectRatio?: string;
  durationSeconds?: number;
  resolution?: string;
  size?: string;
}

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
  kind: "image" | "video";
  assetId: string;
  modelLabel: string;
  prompt: string;
  options?: MediaOptions;
}): string {
  const details = [
    input.options?.aspectRatio,
    input.kind === "video" && input.options?.durationSeconds
      ? `${input.options.durationSeconds}s`
      : null,
    input.options?.resolution,
    input.options?.size,
  ].filter(Boolean);
  return (
    `Generated ${input.kind} with ${input.modelLabel}` +
    (details.length ? ` (${details.join(", ")})` : "") +
    `. Asset ${input.assetId}.\n` +
    `The ${input.kind} itself is not visible to other agents; this is the prompt it was generated from:\n` +
    input.prompt
  );
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
    return out;
  } catch {
    return {};
  }
}
