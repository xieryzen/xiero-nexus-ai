/**
 * Model capability vocabulary. Kept in its own dependency-free module so both
 * server (schema, validation) and client (forms) can import it safely.
 */
export const CAPABILITIES = [
  "text",
  "reasoning",
  "tool_calling",
  "structured_output",
  "vision",
  "audio",
  "image_generation",
  "video_generation",
  "embeddings",
  "streaming",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const CAPABILITY_LABELS: Record<Capability, string> = {
  text: "Text",
  reasoning: "Reasoning",
  tool_calling: "Tool calling",
  structured_output: "Structured output",
  vision: "Vision",
  audio: "Audio",
  image_generation: "Image generation",
  video_generation: "Video generation",
  embeddings: "Embeddings",
  streaming: "Streaming",
};

/** The capability a model needs to generate each kind of media. */
export const MEDIA_CAPABILITY = {
  image: "image_generation",
  video: "video_generation",
} as const satisfies Record<string, Capability>;

/**
 * True for a model that only generates media: it is marked for image or video
 * generation and not for text. Such a model cannot answer a chat request, so
 * it is left out of chat, agents, the AI Manager and automatic routing.
 *
 * A model with no capabilities at all (as imported by discovery) is treated as
 * a chat model, as before.
 */
export function isMediaOnly(capabilities: readonly string[]): boolean {
  const generatesMedia =
    capabilities.includes("image_generation") || capabilities.includes("video_generation");
  return generatesMedia && !capabilities.includes("text");
}
