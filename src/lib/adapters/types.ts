import type { Capability } from "@/lib/capabilities";
import type {
  DownloadPlan,
  ImageRequest,
  ParsedImageResponse,
  ParsedVideoJob,
  VideoRequest,
} from "./media-protocol";

/** A function the model asked to have called (v1.5). */
export interface ToolCall {
  /** The provider's id for the call. The result is sent back under it. */
  id: string;
  name: string;
  /** Parsed arguments; `{}` when the model sent none. */
  arguments: Record<string, unknown>;
  /** The raw text, when the model's arguments were not a JSON object. */
  invalidArguments?: string;
}

/** A function a model may call. `parameters` is a JSON Schema object. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ToolChoice = "auto" | "none" | "required";

/**
 * A provider's own form of an assistant turn. Some providers need parts of it
 * back unchanged on the next request (Anthropic thinking blocks, Gemini thought
 * signatures), so the adapter that produced it sends it again as it is. Other
 * adapters ignore it and use `content` and `toolCalls`.
 */
export interface RawAssistantContent {
  adapter: string;
  content: unknown;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Assistant: the tool calls made in this turn. */
  toolCalls?: ToolCall[];
  /** Tool: the id of the call this is the result of. */
  toolCallId?: string;
  /** Tool: the name of the tool that was called. */
  name?: string;
  /** Tool: the call failed and `content` says why. */
  isError?: boolean;
  /** Assistant: see {@link RawAssistantContent}. */
  raw?: RawAssistantContent;
}

export interface ChatRequest {
  model: string; // upstream model id
  messages: ChatMessage[];
  temperature?: number;
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  /** Upper limit on the answer's length, when the caller set one. */
  maxTokens?: number;
}

export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ChatResult {
  content: string;
  toolCalls?: ToolCall[];
  raw?: RawAssistantContent;
  usage?: ChatUsage;
  finishReason?: string;
}

export interface ListedModel {
  id: string;
  displayName?: string;
  contextWindow?: number;
  /** What the provider's list says the model can do, when it says so. */
  capabilities?: Capability[];
  /**
   * What the provider's list says the model costs, in USD per million tokens,
   * when it says so. Both 0 is a model the provider gives away.
   */
  inputPricePerMTok?: number;
  outputPricePerMTok?: number;
  /** Whether the list names any price above zero for the model (per token, per request or per image). */
  billed?: boolean;
}

export interface EmbedRequest {
  model: string;
  input: string[];
  dimensions?: number;
}

export interface EmbedResult {
  /** One vector per input, in the same order. */
  vectors: number[][];
  promptTokens?: number;
}

export const SPEECH_FORMATS = ["mp3", "wav", "opus", "aac", "flac"] as const;
export type SpeechFormat = (typeof SPEECH_FORMATS)[number];

export interface SpeechRequest {
  model: string;
  input: string;
  voice?: string;
  format?: SpeechFormat;
  /** 0.25 to 4; 1 is normal. */
  speed?: number;
  /** How to speak, for models that take such a hint. */
  instructions?: string;
}

export interface SpeechResult {
  bytes: Buffer;
  /** Set when `bytes` is headerless PCM, which still has to be put into a WAV file. */
  pcm?: { sampleRate: number; channels: number; bitsPerSample: number };
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
  /** The provider's JSON configuration (custom-http adapter). */
  config?: string | null;
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
  /**
   * Streams text deltas; resolves the final aggregated result. Tool calls are
   * not streamed: they are in the result.
   */
  chatStream(
    ctx: ProviderContext,
    req: ChatRequest,
    onDelta: (text: string) => void,
  ): Promise<ChatResult>;

  // ── Optional. Absent on adapters whose protocol has no such API. ──────────

  /** Text embeddings (v1.5). */
  embed?(ctx: ProviderContext, req: EmbedRequest): Promise<EmbedResult>;
  /** Text to speech (v1.5). */
  generateSpeech?(
    ctx: ProviderContext,
    req: SpeechRequest,
    opts: { timeoutMs: number },
  ): Promise<SpeechResult>;

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
