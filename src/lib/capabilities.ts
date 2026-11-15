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
  "speech_generation",
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
  speech_generation: "Speech generation",
  embeddings: "Embeddings",
  streaming: "Streaming",
};

/** The capability a model needs to generate each kind of media. */
export const MEDIA_CAPABILITY = {
  image: "image_generation",
  video: "video_generation",
  audio: "speech_generation",
} as const satisfies Record<string, Capability>;

/** Capabilities of models that do one job other than answering in text. */
const NON_CHAT_CAPABILITIES: readonly Capability[] = [
  "image_generation",
  "video_generation",
  "speech_generation",
  "embeddings",
];

/**
 * True for a model that cannot answer a chat request: it is marked for image,
 * video or speech generation or for embeddings, and not for text. Such a model
 * is left out of chat, agents, the AI Manager and automatic routing.
 *
 * A model with no capabilities at all is treated as a chat model, as before.
 * (The name is from v1.4, when image and video models were the only such
 * models.)
 */
export function isMediaOnly(capabilities: readonly string[]): boolean {
  return (
    NON_CHAT_CAPABILITIES.some((c) => capabilities.includes(c)) && !capabilities.includes("text")
  );
}
