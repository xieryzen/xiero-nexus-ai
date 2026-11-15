import type { Capability } from "@/lib/capabilities";
import { AppError, Errors, sanitizeUpstreamError } from "../errors";
import type { ImageRequest, ParsedImageResponse } from "./media-protocol";
import type {
  ChatMessage,
  ChatRequest,
  ChatResult,
  ChatUsage,
  EmbedResult,
  ListedModel,
  ProviderContext,
  SpeechRequest,
  ToolCall,
} from "./types";

/**
 * Wire format of the Gemini API (Google AI Studio, generativelanguage.googleapis.com):
 * request building, response parsing and the event stream. Pure, so it can be
 * unit-tested. The I/O lives in ./gemini.ts.
 *
 * The Base URL is the API root including its version, e.g.
 * https://generativelanguage.googleapis.com/v1beta. A model is addressed as
 * `models/<id>` below it:
 *
 *   GET  /models                               list
 *   POST /models/<id>:generateContent          chat, images, speech
 *   POST /models/<id>:streamGenerateContent    chat, streamed (?alt=sse)
 *   POST /models/<id>:batchEmbedContents       embeddings
 *
 * Video generation is not part of this API (it is offered on Vertex AI), so
 * this adapter has none.
 */

export const GEMINI_ADAPTER_ID = "gemini";
export const GEMINI_DEFAULT_KEY_HEADER = "x-goog-api-key";
export const GEMINI_MODELS_PAGE_SIZE = 1000;
/** Texts in one batchEmbedContents request. */
export const GEMINI_EMBED_BATCH = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// ─── Requests ────────────────────────────────────────────────────────────────

type HeaderContext = Pick<
  ProviderContext,
  "apiKey" | "authType" | "authHeaderName" | "extraHeaders"
>;

/**
 * The API root requests are sent to: the Base URL with its version. A Base URL
 * that is only the host (https://generativelanguage.googleapis.com) gets the
 * version this adapter is written for.
 */
export function geminiBase(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  try {
    const path = new URL(trimmed).pathname;
    if (path === "" || path === "/") return `${trimmed}/v1beta`;
  } catch {
    /* not a URL: the request fails where it is sent, with a proper message */
  }
  return trimmed;
}

/**
 * Request headers. An API key goes into `x-goog-api-key` whichever auth type
 * is chosen, unless a custom header name is set: `Authorization: Bearer` is
 * for OAuth tokens there, and an API key sent that way is refused. Choose
 * "Custom header" with the name `authorization` to send an OAuth token.
 */
export function geminiHeaders(ctx: HeaderContext): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (ctx.apiKey && ctx.authType !== "none") {
    const name =
      ctx.authType === "header" && ctx.authHeaderName?.trim()
        ? ctx.authHeaderName.trim().toLowerCase()
        : GEMINI_DEFAULT_KEY_HEADER;
    h[name] = name === "authorization" ? `Bearer ${ctx.apiKey}` : ctx.apiKey;
  }
  for (const [k, v] of Object.entries(ctx.extraHeaders ?? {})) {
    h[k.toLowerCase()] = v;
  }
  return h;
}

/**
 * The path of a model below the Base URL. Ids are stored without the
 * `models/` prefix; one that already has it, or names a tuned model, is used
 * as it is. The id becomes part of a URL, so anything that could change the
 * path or add a query is refused.
 */
export function modelPath(model: string): string {
  const name = model.trim();
  if (!name || /[?#&\s\\]|\.\./.test(name)) throw Errors.badRequest("Invalid model id");
  const full = /^(models|tunedModels)\//.test(name) ? name : `models/${name}`;
  const segments = full.split("/");
  if (segments.some((s) => s === "" || s === ".")) throw Errors.badRequest("Invalid model id");
  return `/${segments.map(encodeURIComponent).join("/")}`;
}

/** The id as stored: a listed `models/<id>` without its prefix. */
export function modelIdFromName(name: string): string {
  return name.startsWith("models/") ? name.slice("models/".length) : name;
}

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name?: string; args?: unknown };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
  inlineData?: { mimeType?: string; data?: string };
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

/** Ids made up here, for calls the API returned without one. */
const SYNTHETIC_ID = /^gemini-call-\d+-/;

function syntheticCallId(index: number, name: string): string {
  return `gemini-call-${index}-${name}`;
}

function modelParts(m: ChatMessage): GeminiPart[] {
  // Parts this adapter received are sent back as they came: a function call
  // carries a thought signature that the API checks on the next request.
  if (m.raw?.adapter === GEMINI_ADAPTER_ID && Array.isArray(m.raw.content)) {
    const parts = (m.raw.content as unknown[]).filter(isRecord) as GeminiPart[];
    if (parts.length > 0) return parts;
  }
  const parts: GeminiPart[] = [];
  if (m.content.trim()) parts.push({ text: m.content });
  for (const call of m.toolCalls ?? []) {
    const fc: GeminiPart["functionCall"] = { name: call.name, args: call.arguments ?? {} };
    if (!SYNTHETIC_ID.test(call.id)) fc.id = call.id;
    parts.push({ functionCall: fc });
  }
  return parts;
}

/**
 * Split gateway messages into the `systemInstruction` and the turns. The
 * assistant is the role `model` there; tool results are `functionResponse`
 * parts of a user turn. Neighbouring turns of one role are joined, because
 * the API expects the roles to alternate.
 */
export function toGeminiContents(messages: ChatMessage[]): {
  systemInstruction?: { parts: { text: string }[] };
  contents: GeminiContent[];
} {
  const system: string[] = [];
  const contents: GeminiContent[] = [];
  const push = (role: "user" | "model", parts: GeminiPart[]) => {
    if (parts.length === 0) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts: [...parts] });
  };

  for (const m of messages) {
    if (m.role === "system") {
      if (m.content.trim()) system.push(m.content.trim());
    } else if (m.role === "assistant") {
      push("model", modelParts(m));
    } else if (m.role === "tool") {
      const response: GeminiPart["functionResponse"] = {
        name: m.name ?? "tool",
        response: m.isError ? { error: m.content } : { result: m.content },
      };
      if (m.toolCallId && !SYNTHETIC_ID.test(m.toolCallId)) response.id = m.toolCallId;
      push("user", [{ functionResponse: response }]);
    } else if (m.content.trim()) {
      push("user", [{ text: m.content }]);
    }
  }
  return {
    systemInstruction: system.length > 0 ? { parts: [{ text: system.join("\n\n") }] } : undefined,
    contents,
  };
}

const TOOL_MODE = { auto: "AUTO", required: "ANY", none: "NONE" } as const;

/** Body of `:generateContent` and `:streamGenerateContent` for a chat request. */
export function buildGenerateBody(req: ChatRequest): Record<string, unknown> {
  const { systemInstruction, contents } = toGeminiContents(req.messages);
  if (contents.length === 0) {
    throw Errors.badRequest("A Gemini request needs at least one user or assistant message");
  }
  const body: Record<string, unknown> = { contents };
  if (systemInstruction) body.systemInstruction = systemInstruction;
  if (req.tools?.length) {
    body.tools = [
      {
        functionDeclarations: req.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          // Standard JSON Schema; `parameters` would take the API's own subset.
          parametersJsonSchema: tool.parameters,
        })),
      },
    ];
    if (req.toolChoice) {
      body.toolConfig = { functionCallingConfig: { mode: TOOL_MODE[req.toolChoice] } };
    }
  }
  const generationConfig: Record<string, unknown> = {};
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
  if (req.maxTokens !== undefined) generationConfig.maxOutputTokens = req.maxTokens;
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
  return body;
}

/** Path and query of one page of the model list. */
export function modelsListPath(opts: { pageSize: number; pageToken?: string }): string {
  const query = new URLSearchParams({ pageSize: String(opts.pageSize) });
  if (opts.pageToken) query.set("pageToken", opts.pageToken);
  return `/models?${query.toString()}`;
}

// ─── Responses ───────────────────────────────────────────────────────────────

/** Message for a non-2xx response; prefers the API's own `error.message`. */
export function upstreamErrorMessage(status: number, body: string, statusText = ""): string {
  let detail = body.trim() || statusText || "Unknown upstream error";
  try {
    const parsed = JSON.parse(body) as unknown;
    // Errors come as { error: { code, message, status } }, at times in a list.
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    const error = isRecord(first) && isRecord(first.error) ? first.error : null;
    if (error && typeof error.message === "string" && error.message) detail = error.message;
  } catch {
    /* not JSON: keep the raw body */
  }
  return `Provider responded ${status}: ${sanitizeUpstreamError(detail)}`;
}

function parseUsage(meta: unknown): ChatUsage | undefined {
  if (!isRecord(meta)) return undefined;
  const prompt = num(meta.promptTokenCount);
  const candidates = num(meta.candidatesTokenCount);
  const thoughts = num(meta.thoughtsTokenCount);
  // Thinking is billed as output and is not part of candidatesTokenCount.
  const completion =
    candidates === undefined && thoughts === undefined
      ? undefined
      : (candidates ?? 0) + (thoughts ?? 0);
  const total = num(meta.totalTokenCount);
  if (prompt === undefined && completion === undefined && total === undefined) return undefined;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens:
      total ?? (prompt !== undefined && completion !== undefined ? prompt + completion : undefined),
  };
}

/** Finish reasons that mean the answer was withheld rather than completed. */
const BLOCKED_FINISH = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
]);

function refusal(reason: string, detail?: string): AppError {
  return new AppError(
    422,
    "upstream_refusal",
    `The model declined this request: [${sanitizeUpstreamError(reason)}]` +
      (detail ? ` ${sanitizeUpstreamError(detail)}` : ""),
  );
}

/** Throw when the prompt itself was blocked: there are no candidates then. */
function assertNotBlocked(json: Record<string, unknown>): void {
  const feedback = isRecord(json.promptFeedback) ? json.promptFeedback : null;
  if (feedback && typeof feedback.blockReason === "string" && feedback.blockReason) {
    throw refusal(
      feedback.blockReason,
      typeof feedback.blockReasonMessage === "string" ? feedback.blockReasonMessage : undefined,
    );
  }
}

function candidateParts(json: Record<string, unknown>): {
  parts: GeminiPart[];
  finishReason?: string;
  finishMessage?: string;
} {
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  const candidate = isRecord(candidates[0]) ? candidates[0] : null;
  if (!candidate) return { parts: [] };
  const content = isRecord(candidate.content) ? candidate.content : null;
  const parts = content && Array.isArray(content.parts) ? content.parts.filter(isRecord) : [];
  return {
    parts: parts as GeminiPart[],
    finishReason: typeof candidate.finishReason === "string" ? candidate.finishReason : undefined,
    finishMessage: typeof candidate.finishMessage === "string" ? candidate.finishMessage : undefined,
  };
}

/** The visible text of some parts: thought summaries are not the answer. */
function textOf(parts: GeminiPart[]): string {
  return parts.map((p) => (typeof p.text === "string" && !p.thought ? p.text : "")).join("");
}

function toolCallsOf(parts: GeminiPart[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const part of parts) {
    const fc = part.functionCall;
    if (!fc || typeof fc.name !== "string" || !fc.name) continue;
    calls.push({
      id: typeof fc.id === "string" && fc.id ? fc.id : syntheticCallId(calls.length, fc.name),
      name: fc.name,
      arguments: isRecord(fc.args) ? fc.args : {},
    });
  }
  return calls;
}

function finish(
  parts: GeminiPart[],
  finishReason: string | undefined,
  finishMessage: string | undefined,
  usage: ChatUsage | undefined,
): ChatResult {
  const content = textOf(parts);
  const toolCalls = toolCallsOf(parts);
  if (finishReason === "MALFORMED_FUNCTION_CALL") {
    throw new AppError(
      502,
      "upstream_error",
      "The model wrote a tool call that could not be read" +
        (finishMessage ? `: ${sanitizeUpstreamError(finishMessage)}` : ""),
    );
  }
  if (finishReason && BLOCKED_FINISH.has(finishReason) && !content && toolCalls.length === 0) {
    throw refusal(finishReason, finishMessage);
  }
  const result: ChatResult = { content, finishReason, usage };
  if (toolCalls.length > 0) {
    result.toolCalls = toolCalls;
    result.raw = { adapter: GEMINI_ADAPTER_ID, content: parts };
  }
  return result;
}

/** Parse a `:generateContent` response of a chat request. */
export function parseGenerateResponse(json: unknown): ChatResult {
  if (!isRecord(json)) {
    throw new AppError(502, "upstream_error", "Provider returned a response that is not a Gemini answer");
  }
  assertNotBlocked(json);
  if (!Array.isArray(json.candidates) || json.candidates.length === 0) {
    throw new AppError(502, "upstream_error", "Provider returned a response without candidates");
  }
  const { parts, finishReason, finishMessage } = candidateParts(json);
  return finish(parts, finishReason, finishMessage, parseUsage(json.usageMetadata));
}

/**
 * Fold the chunks of `:streamGenerateContent?alt=sse` into one result. Each
 * `data:` line is a whole response object holding the next parts; the usage
 * of the last chunk that has one is the total.
 */
export function createGenerateStream(onDelta: (text: string) => void): {
  handle(payload: string): void;
  result(): ChatResult;
} {
  const parts: GeminiPart[] = [];
  let usage: ChatUsage | undefined;
  let finishReason: string | undefined;
  let finishMessage: string | undefined;
  let sawChunk = false;

  return {
    handle(payload) {
      if (!payload) return;
      let chunk: unknown;
      try {
        chunk = JSON.parse(payload);
      } catch {
        return;
      }
      if (!isRecord(chunk)) return;
      if (isRecord(chunk.error)) {
        const message = typeof chunk.error.message === "string" ? chunk.error.message : payload;
        throw new AppError(502, "upstream_error", `Provider stream error: ${sanitizeUpstreamError(message)}`);
      }
      sawChunk = true;
      assertNotBlocked(chunk);
      const piece = candidateParts(chunk);
      for (const part of piece.parts) {
        parts.push(part);
        if (typeof part.text === "string" && part.text && !part.thought) onDelta(part.text);
      }
      if (piece.finishReason) finishReason = piece.finishReason;
      if (piece.finishMessage) finishMessage = piece.finishMessage;
      const chunkUsage = parseUsage(chunk.usageMetadata);
      if (chunkUsage) usage = chunkUsage;
    },
    result() {
      if (!sawChunk) {
        throw new AppError(502, "upstream_error", "Provider returned no events in its stream");
      }
      return finish(parts, finishReason, finishMessage, usage);
    },
  };
}

// ─── Models ──────────────────────────────────────────────────────────────────

/**
 * One page of the model list. Only models this adapter can use are kept: those
 * that answer `generateContent` or `embedContent`. What each one is for is
 * read from its methods and, for image and speech models, from its name.
 */
export function parseModelsPage(json: unknown): { models: ListedModel[]; nextPageToken?: string } {
  const list = isRecord(json) && Array.isArray(json.models) ? json.models : [];
  const models: ListedModel[] = [];
  for (const item of list) {
    if (!isRecord(item) || typeof item.name !== "string" || !item.name) continue;
    const methods = Array.isArray(item.supportedGenerationMethods)
      ? item.supportedGenerationMethods.filter((m): m is string => typeof m === "string")
      : [];
    const generates = methods.includes("generateContent");
    const embeds = methods.includes("embedContent") || methods.includes("batchEmbedContents");
    if (methods.length > 0 && !generates && !embeds) continue;

    const id = modelIdFromName(item.name);
    const listed: ListedModel = { id };
    if (typeof item.displayName === "string" && item.displayName) {
      listed.displayName = item.displayName.slice(0, 120);
    }
    const context = num(item.inputTokenLimit);
    if (context && context > 0) listed.contextWindow = Math.round(context);

    const lower = id.toLowerCase();
    const caps: Capability[] = [];
    if (embeds && !generates) caps.push("embeddings");
    else if (generates && /(^|[-_.])tts([-_.]|$)/.test(lower)) caps.push("speech_generation");
    // An image model answers chat requests too, but it is there for its
    // pictures: marked as a chat model it would be offered to agents and to
    // automatic routing. "Text" can be ticked for it on the Models page.
    else if (generates && /(^|[-_.])image([-_.]|$)/.test(lower)) caps.push("image_generation");
    else if (generates) {
      caps.push("text", "tool_calling", "vision", "structured_output", "streaming");
      if (item.thinking === true) caps.push("reasoning");
    }
    if (caps.length > 0) listed.capabilities = caps;
    models.push(listed);
  }
  const next = isRecord(json) && typeof json.nextPageToken === "string" ? json.nextPageToken : "";
  return { models, nextPageToken: next || undefined };
}

// ─── Embeddings ──────────────────────────────────────────────────────────────

export function buildEmbedBody(req: {
  model: string;
  input: string[];
  dimensions?: number;
}): Record<string, unknown> {
  const model = modelPath(req.model).slice(1); // "models/<id>", as the body wants it
  return {
    requests: req.input.map((text) => ({
      model: decodeURIComponent(model),
      content: { parts: [{ text }] },
      ...(req.dimensions ? { outputDimensionality: req.dimensions } : {}),
    })),
  };
}

export function parseEmbedResponse(json: unknown, expected: number): EmbedResult {
  const list = isRecord(json) && Array.isArray(json.embeddings) ? json.embeddings : null;
  if (!list || list.length < expected) {
    throw new AppError(502, "upstream_error", "Provider returned fewer embeddings than texts");
  }
  const vectors = list.slice(0, expected).map((item) => {
    const values = isRecord(item) && Array.isArray(item.values) ? item.values : [];
    const vector = values.filter((v): v is number => typeof v === "number");
    if (vector.length === 0 || vector.length !== values.length) {
      throw new AppError(502, "upstream_error", "Provider returned an embedding that is not a list of numbers");
    }
    return vector;
  });
  return { vectors };
}

// ─── Images and speech (generateContent with another output modality) ────────

/** Aspect ratios the image models take. Others are left to the model. */
const IMAGE_ASPECT_RATIOS = new Set([
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
]);

/** Body of `:generateContent` for one image. */
export function buildImageBody(req: ImageRequest): Record<string, unknown> {
  const imageConfig: Record<string, unknown> = {};
  if (req.aspectRatio && IMAGE_ASPECT_RATIOS.has(req.aspectRatio)) {
    imageConfig.aspectRatio = req.aspectRatio;
  }
  // "1K", "2K" or "4K"; other resolution values belong to other providers.
  if (req.resolution && /^[124]k$/i.test(req.resolution)) {
    imageConfig.imageSize = req.resolution.toUpperCase();
  }
  const generationConfig: Record<string, unknown> = { responseModalities: ["TEXT", "IMAGE"] };
  if (Object.keys(imageConfig).length > 0) generationConfig.imageConfig = imageConfig;
  return {
    ...(isRecord(req.extra) ? req.extra : {}),
    contents: [{ role: "user", parts: [{ text: req.prompt }] }],
    generationConfig,
  };
}

/** The images of a `:generateContent` response, as the media service reads them. */
export function parseImageResponse(json: unknown): ParsedImageResponse {
  const out: ParsedImageResponse = { images: [] };
  if (!isRecord(json)) return out;
  const feedback = isRecord(json.promptFeedback) ? json.promptFeedback : null;
  if (feedback && typeof feedback.blockReason === "string" && feedback.blockReason) {
    out.error = `The model declined this request: [${feedback.blockReason}]`;
    return out;
  }
  const { parts, finishReason } = candidateParts(json);
  for (const part of parts) {
    const data = part.inlineData?.data;
    const mime = part.inlineData?.mimeType ?? "";
    if (typeof data === "string" && data && (!mime || mime.startsWith("image/"))) {
      out.images.push({ b64: data });
    }
  }
  const usage = parseUsage(json.usageMetadata);
  out.inputTokens = usage?.promptTokens;
  out.outputTokens = usage?.completionTokens;
  if (out.images.length === 0) {
    const said = textOf(parts).trim();
    out.error =
      finishReason && finishReason !== "STOP"
        ? `The model returned no image (${finishReason})`
        : said
          ? `The model answered in text instead of an image: ${said.slice(0, 200)}`
          : undefined;
  }
  return out;
}

/** Body of `:generateContent` for speech. */
export function buildSpeechBody(req: SpeechRequest): Record<string, unknown> {
  const text = req.instructions?.trim() ? `${req.instructions.trim()}: ${req.input}` : req.input;
  return {
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: req.voice?.trim() || "Kore" } },
      },
    },
  };
}

/** The audio of a speech response: base64 data and the MIME type it came with. */
export function parseSpeechResponse(json: unknown): { b64: string; mimeType: string } {
  if (!isRecord(json)) {
    throw new AppError(502, "upstream_error", "Provider returned a response that is not a Gemini answer");
  }
  assertNotBlocked(json);
  const { parts, finishReason } = candidateParts(json);
  for (const part of parts) {
    const data = part.inlineData?.data;
    if (typeof data === "string" && data) {
      return { b64: data, mimeType: part.inlineData?.mimeType ?? "" };
    }
  }
  throw new AppError(
    502,
    "upstream_error",
    finishReason && finishReason !== "STOP"
      ? `The model returned no audio (${finishReason})`
      : "The model returned no audio",
  );
}
