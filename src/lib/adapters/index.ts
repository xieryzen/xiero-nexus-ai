import "server-only";
import { AppError } from "../errors";
import { openAiCompatibleAdapter } from "./openai";
import type { ProviderAdapter } from "./types";

/**
 * Adapter registry. v1.0.0 ships the OpenAI-compatible adapter. Additional
 * protocols (Anthropic, Gemini, custom HTTP) are planned — register them here
 * once implemented. A provider whose adapter is not registered is rejected
 * rather than silently treated as OpenAI-compatible.
 */
const registry: Record<string, ProviderAdapter | undefined> = {
  "openai-compatible": openAiCompatibleAdapter,
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

export type { ProviderAdapter } from "./types";
