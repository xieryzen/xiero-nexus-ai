import "server-only";
import { AppError } from "../errors";
import { anthropicAdapter } from "./anthropic";
import { openAiCompatibleAdapter } from "./openai";
import type { ProviderAdapter } from "./types";

/**
 * Adapter registry: the OpenAI-compatible and Anthropic protocols. Gemini and
 * custom HTTP are planned — register them here once implemented. A provider
 * whose adapter is not registered is rejected rather than silently treated as
 * OpenAI-compatible.
 */
const registry: Record<string, ProviderAdapter | undefined> = {
  "openai-compatible": openAiCompatibleAdapter,
  anthropic: anthropicAdapter,
};

export function getAdapter(adapterId: string): ProviderAdapter {
  const adapter = registry[adapterId];
  if (!adapter) {
    throw new AppError(
      400,
      "adapter_unavailable",
      `No adapter is implemented for "${adapterId}" yet`,
    );
  }
  return adapter;
}

export function adapterIsImplemented(adapterId: string): boolean {
  return Boolean(registry[adapterId]);
}

/** Whether a provider on this adapter can generate images or videos. */
export function adapterSupportsMedia(adapterId: string): boolean {
  const adapter = registry[adapterId];
  return Boolean(adapter?.generateImages || adapter?.startVideo);
}

export type { ProviderAdapter } from "./types";
