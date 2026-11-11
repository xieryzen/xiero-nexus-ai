import type { Capability } from "@/db/schema";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string; // upstream model id
  messages: ChatMessage[];
  temperature?: number;
}

export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ChatResult {
  content: string;
  usage?: ChatUsage;
  finishReason?: string;
}

export interface ListedModel {
  id: string;
}

/** Everything an adapter needs to talk to one provider connection. */
export interface ProviderContext {
  baseUrl: string;
  apiKey?: string;
  authType: "bearer" | "header" | "none";
  authHeaderName?: string | null;
  apiVersion?: string | null;
  extraHeaders?: Record<string, string>;
  timeoutMs: number;
  allowHosts?: string[];
}

export interface ProviderAdapter {
  id: string;
  label: string;
  /** Capabilities this adapter can, in principle, support. */
  supports: readonly Capability[];
  /** Whether model discovery (list endpoint) is available. */
  canDiscoverModels: boolean;
  listModels(ctx: ProviderContext): Promise<ListedModel[]>;
  testConnection(ctx: ProviderContext): Promise<void>;
  chat(ctx: ProviderContext, req: ChatRequest): Promise<ChatResult>;
  /** Streams text deltas; resolves the final aggregated result. */
  chatStream(
    ctx: ProviderContext,
    req: ChatRequest,
    onDelta: (text: string) => void,
  ): Promise<ChatResult>;
}
