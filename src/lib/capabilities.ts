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
  embeddings: "Embeddings",
  streaming: "Streaming",
};
