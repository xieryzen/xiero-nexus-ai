import type { Capability } from "./capabilities";

/**
 * What a model is for, guessed from its id. A provider's model list is mostly
 * just names, and a model imported without a type used to count as a chat
 * model until someone changed it by hand: an image or video model then showed
 * up in chat and could not be picked in Creative Studio.
 *
 * Pure. A guess is only a starting point: the capabilities are set as
 * unverified and can be changed on the Models page.
 */
export type ModelType = "chat" | "image" | "video" | "speech" | "transcription" | "embedding";

export const MODEL_TYPE_LABELS: Record<ModelType, string> = {
  chat: "Chat",
  image: "Image",
  video: "Video",
  speech: "Speech",
  transcription: "Transcription",
  embedding: "Embeddings",
};

/** `word` as a whole part of an id: "wan-2.7" and "alibaba/wan" but not "swan". */
function part(word: string): RegExp {
  return new RegExp(`(^|[^a-z0-9])${word}([^a-z]|$)`);
}

const EMBEDDING = [/embed/, part("bge"), part("e5"), part("gte"), /text-similarity/];
const VIDEO = [
  /video/,
  part("sora"),
  part("veo"),
  part("kling"),
  part("wan"),
  part("seedance"),
  part("hailuo"),
  part("luma"),
  part("runway"),
  part("pika"),
  part("ltx"),
  part("mochi"),
  part("vidu"),
  /cogvideo/,
];
const IMAGE = [
  part("image"),
  /dall-?e/,
  part("imagen"),
  part("flux"),
  /stable-?diffusion/,
  part("sdxl"),
  part("sd3"),
  /midjourney/,
  part("ideogram"),
  part("recraft"),
  part("seedream"),
  part("hidream"),
  /kandinsky/,
  /nano-?banana/,
];
const TRANSCRIPTION = [/whisper/, /transcri/, part("stt"), /speech-to-text/];
const SPEECH = [part("tts"), /text-to-speech/, part("speech"), part("kokoro"), part("orpheus"), /playai/];

export function guessModelType(modelId: string): ModelType {
  const id = modelId.toLowerCase();
  const matches = (patterns: RegExp[]) => patterns.some((p) => p.test(id));
  if (matches(EMBEDDING)) return "embedding";
  if (matches(VIDEO)) return "video";
  if (matches(IMAGE)) return "image";
  if (matches(TRANSCRIPTION)) return "transcription";
  if (matches(SPEECH)) return "speech";
  return "chat";
}

export function capabilitiesForType(type: ModelType): Capability[] {
  switch (type) {
    case "chat":
      return ["text"];
    case "image":
      return ["image_generation"];
    case "video":
      return ["video_generation"];
    case "speech":
      return ["speech_generation"];
    case "transcription":
      return ["audio"];
    case "embedding":
      return ["embeddings"];
  }
}

/** The type a set of capabilities amounts to, for showing next to a model. */
export function typeOfCapabilities(capabilities: readonly string[]): ModelType {
  if (capabilities.includes("text")) return "chat";
  if (capabilities.includes("video_generation")) return "video";
  if (capabilities.includes("image_generation")) return "image";
  if (capabilities.includes("speech_generation")) return "speech";
  if (capabilities.includes("embeddings")) return "embedding";
  if (capabilities.includes("audio")) return "transcription";
  return "chat";
}

export interface ModelSuggestion {
  type: ModelType;
  capabilities: Capability[];
  contextWindow?: number;
  displayName?: string;
}

/**
 * The capabilities to import a listed model with: what the provider's list
 * says when it says something, otherwise a guess from the id.
 */
export function suggestModel(listed: {
  id: string;
  capabilities?: Capability[];
  contextWindow?: number;
  displayName?: string;
}): ModelSuggestion {
  const fromList = listed.capabilities?.length ? [...new Set(listed.capabilities)] : null;
  const capabilities = fromList ?? capabilitiesForType(guessModelType(listed.id));
  const suggestion: ModelSuggestion = { type: typeOfCapabilities(capabilities), capabilities };
  if (listed.contextWindow) suggestion.contextWindow = listed.contextWindow;
  if (listed.displayName) suggestion.displayName = listed.displayName;
  return suggestion;
}
