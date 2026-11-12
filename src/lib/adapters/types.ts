import type { Capability } from "@/db/schema";
import type {
  DownloadPlan,
  ImageRequest,
  ParsedImageResponse,
  ParsedVideoJob,
  VideoRequest,
} from "./media-protocol";

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
  /** The provider's media style setting ("auto", "openai", "openrouter", "xai"). */
  mediaApi?: string | null;
  extraHeaders?: Record<string, string>;
  timeoutMs: number;
  allowHosts?: string[];
}

/** Where a finished media file is fetched from, and the headers to send. */
export interface MediaDownload extends DownloadPlan {
  /** Credentials for the provider's own origin. Sent only when `withAuth`. */
  authHeaders: Record<string, string>;
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

  // ── Media (v1.4). Absent on adapters whose protocol has no such API. ──────

  /** Generate images. Waits for the provider's complete answer. */
  generateImages?(
    ctx: ProviderContext,
    req: ImageRequest,
    opts: { timeoutMs: number },
  ): Promise<ParsedImageResponse>;
  /** Submit a video job. The result is read with `getVideo`. */
  startVideo?(ctx: ProviderContext, req: VideoRequest): Promise<ParsedVideoJob>;
  /** The current state of a video job. */
  getVideo?(ctx: ProviderContext, jobId: string): Promise<ParsedVideoJob>;
  /** How to download a link the provider returned (an image, or a finished video). */
  mediaDownload?(ctx: ProviderContext, link: string): MediaDownload | null;
  /** How to download the file of a finished video job. */
  videoDownload?(ctx: ProviderContext, jobId: string, job: ParsedVideoJob): MediaDownload;
}
