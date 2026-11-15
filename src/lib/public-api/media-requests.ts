/**
 * The media requests of the public API: read leniently from JSON in the
 * shapes OpenAI clients send, and checked against the same rules as the
 * dashboard's forms. Pure.
 */
import { z } from "zod";
import {
  ASPECT_RATIO_PATTERN,
  MAX_IMAGES_PER_REQUEST,
  MAX_MEDIA_PROMPT_CHARS,
  MAX_VIDEO_SECONDS,
  RESOLUTION_PATTERN,
  SIZE_PATTERN,
} from "../adapters/media-protocol";
import { SPEECH_FORMATS } from "../adapters/types";
import {
  MAX_SPEECH_CHARS,
  MAX_SPEECH_SPEED,
  MIN_SPEECH_SPEED,
  VOICE_PATTERN,
} from "../creative/prompt";
import { RequestError } from "./openai-format";

const model = z.string().trim().min(1, "model is required").max(300);
const prompt = z.string().trim().min(1, "prompt is required").max(MAX_MEDIA_PROMPT_CHARS);
const aspectRatio = z.string().trim().regex(ASPECT_RATIO_PATTERN, "use a ratio such as 9:16");
const resolution = z.string().trim().regex(RESOLUTION_PATTERN, "use a value such as 720p or 2K");
const size = z.string().trim().regex(SIZE_PATTERN, "use WIDTHxHEIGHT, such as 1024x1536");

export const apiImageSchema = z.object({
  model,
  prompt,
  n: z.number().int().min(1).max(MAX_IMAGES_PER_REQUEST).optional(),
  size: size.optional(),
  aspect_ratio: aspectRatio.optional(),
  resolution: resolution.optional(),
  response_format: z.enum(["url", "b64_json"]).optional(),
});

export const apiSpeechSchema = z.object({
  model,
  input: z.string().trim().min(1, "input is required").max(MAX_SPEECH_CHARS),
  voice: z.string().trim().regex(VOICE_PATTERN, "use the voice's name").optional(),
  // "pcm" is not offered: the answer is always a file a player opens.
  response_format: z.enum(SPEECH_FORMATS).optional(),
  speed: z.number().min(MIN_SPEECH_SPEED).max(MAX_SPEECH_SPEED).optional(),
  instructions: z.string().trim().max(1000).optional(),
});

const secondsValue = z.coerce.number().int().min(1).max(MAX_VIDEO_SECONDS);

export const apiVideoSchema = z.object({
  model,
  prompt,
  // OpenAI's name, and the name the other video APIs use.
  seconds: secondsValue.optional(),
  duration: secondsValue.optional(),
  size: size.optional(),
  aspect_ratio: aspectRatio.optional(),
  resolution: resolution.optional(),
  // An image in this server's library that the video starts from.
  image_asset_id: z.string().uuid().optional(),
});

/** Check a body against a schema, or throw what the API answers with. */
export function parseApiBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const param = issue?.path.join(".") || undefined;
  throw new RequestError(`${param ? `${param}: ` : ""}${issue?.message ?? "Invalid request"}`, param);
}
