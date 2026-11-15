import "server-only";
import { AppError } from "../errors";
import { anthropicAdapter } from "./anthropic";
import { customHttpAdapter } from "./custom-http";
import { geminiAdapter } from "./gemini";
import { openAiCompatibleAdapter } from "./openai";
import type { ProviderAdapter } from "./types";

/**
 * Adapter registry: the OpenAI-compatible, Anthropic and Gemini protocols, and
 * custom HTTP for a JSON API that follows none of them. A provider whose
 * adapter is not registered is rejected rather than silently treated as
 * OpenAI-compatible.
 */
const registry: Record<string, ProviderAdapter | undefined> = {
  "openai-compatible": openAiCompatibleAdapter,
  anthropic: anthropicAdapter,
  gemini: geminiAdapter,
  "custom-http": customHttpAdapter,
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

/** Whether a provider on this adapter can generate images, videos or speech. */
export function adapterSupportsMedia(adapterId: string): boolean {
  const adapter = registry[adapterId];
  return Boolean(adapter?.generateImages || adapter?.startVideo || adapter?.generateSpeech);
}

/** What a provider on this adapter can do besides chat. For the forms. */
export interface AdapterAbilities {
  image: boolean;
  video: boolean;
  audio: boolean;
  embed: boolean;
  tools: boolean;
}

export function adapterAbilities(adapterId: string): AdapterAbilities {
  const adapter = registry[adapterId];
  return {
    image: Boolean(adapter?.generateImages),
    video: Boolean(adapter?.startVideo && adapter.getVideo),
    audio: Boolean(adapter?.generateSpeech),
    embed: Boolean(adapter?.embed),
    tools: Boolean(adapter?.supports.includes("tool_calling")),
  };
}

/** The adapters that can generate each kind of media, by their labels. */
export function adaptersFor(kind: "image" | "video" | "audio" | "embed"): string[] {
  return Object.values(registry)
    .filter((a): a is ProviderAdapter => Boolean(a))
    .filter((a) =>
      kind === "image"
        ? a.generateImages
        : kind === "video"
          ? a.startVideo && a.getVideo
          : kind === "audio"
            ? a.generateSpeech
            : a.embed,
    )
    .map((a) => a.label);
}

export type { ProviderAdapter } from "./types";
