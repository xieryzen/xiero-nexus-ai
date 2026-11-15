import { AppError, Errors, sanitizeUpstreamError } from "../errors";
import type {
  ChatMessage,
  ChatRequest,
  ChatResult,
  ChatUsage,
  ProviderContext,
  ToolCall,
} from "./types";

/**
 * Wire format of the Anthropic Messages API: request building, response
 * parsing and the server-sent event stream. Pure — no network, env or
 * server-only — so it can be unit-tested. The I/O lives in ./anthropic.ts.
 */

/** Sent as `anthropic-version` unless the provider sets its own API version. */
export const ANTHROPIC_DEFAULT_API_VERSION = "2026-10-21";

/**
 * `max_tokens` is required by the API and caps thinking plus the visible reply.
 * Thinking is on by default on Claude 5 models, so a cap sized for the reply
 * alone can be used up before any text is written. 16,000 leaves room for both
 * and is below the output limit of every model Anthropic currently lists. It
 * does not count towards output rate limits; only generated tokens do.
 */
export const ANTHROPIC_MAX_TOKENS = 16_000;

/** Largest page the Models API returns. */
export const ANTHROPIC_MODELS_PAGE_SIZE = 1000;

// ─── Request ──────────────────────────────────────────────────────────────────

type HeaderContext = Pick<
  ProviderContext,
  "apiKey" | "authType" | "authHeaderName" | "apiVersion" | "extraHeaders"
>;

/**
 * Request headers. The API accepts the key as `Authorization: Bearer` or as
 * `x-api-key`; a proxy in front of it may read only one of them, so the
 * provider's auth type decides which is sent.
 */
export function anthropicHeaders(ctx: HeaderContext): Record<string, string> {
  const h: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": ctx.apiVersion?.trim() || ANTHROPIC_DEFAULT_API_VERSION,
  };
  if (ctx.apiKey && ctx.authType === "bearer") {
    h["authorization"] = `Bearer ${ctx.apiKey}`;
  } else if (ctx.apiKey && ctx.authType === "header") {
    h[(ctx.authHeaderName?.trim() || "x-api-key").toLowerCase()] = ctx.apiKey;
  }
  for (const [k, v] of Object.entries(ctx.extraHeaders ?? {})) {
    h[k.toLowerCase()] = v;
  }
  return h;
}

/** A content block of a request. Only the kinds this adapter writes. */
export type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: true };

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicBlock[];
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicMessagesPayload {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?: { type: "auto" | "any" | "none" };
  stream?: true;
}

export const ANTHROPIC_ADAPTER_ID = "anthropic";

/**
 * The blocks of an assistant turn that go back to the API: text, tool calls
 * and thinking. Thinking blocks have to be returned exactly as they came (the
 * signature is checked), so only their own fields are copied and nothing is
 * rewritten. Blocks of any other kind are dropped.
 */
export function echoBlocks(raw: unknown): AnthropicBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: AnthropicBlock[] = [];
  for (const item of raw) {
    const block = asObject<Record<string, unknown>>(item);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") {
      if (block.text) out.push({ type: "text", text: block.text });
    } else if (
      block.type === "thinking" &&
      typeof block.thinking === "string" &&
      typeof block.signature === "string"
    ) {
      out.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
    } else if (block.type === "redacted_thinking" && typeof block.data === "string") {
      out.push({ type: "redacted_thinking", data: block.data });
    } else if (
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      out.push({ type: "tool_use", id: block.id, name: block.name, input: block.input ?? {} });
    }
  }
  return out;
}

function assistantContent(m: ChatMessage): string | AnthropicBlock[] | null {
  if (m.raw?.adapter === ANTHROPIC_ADAPTER_ID) {
    const blocks = echoBlocks(m.raw.content);
    if (blocks.length > 0) return blocks;
  }
  if (!m.toolCalls?.length) return m.content.trim() ? m.content : null;
  const blocks: AnthropicBlock[] = [];
  if (m.content.trim()) blocks.push({ type: "text", text: m.content });
  for (const call of m.toolCalls) {
    blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments ?? {} });
  }
  return blocks;
}

/**
 * Split gateway messages into Anthropic's top-level `system` prompt and its
 * user/assistant turns. Blank messages are dropped because the API rejects
 * empty content. Tool results are user turns there: the results of one
 * assistant turn, and any user text that follows them, are put into a single
 * user message with the results first, as the API requires.
 */
export function toAnthropicMessages(messages: ChatMessage[]): {
  system?: string;
  messages: AnthropicMessage[];
} {
  const system: string[] = [];
  const turns: AnthropicMessage[] = [];

  /** Add blocks to the user turn at the end, or start one. */
  const pushUser = (blocks: AnthropicBlock[]) => {
    const last = turns[turns.length - 1];
    if (last && last.role === "user" && Array.isArray(last.content)) {
      last.content.push(...blocks);
    } else {
      turns.push({ role: "user", content: blocks });
    }
  };

  for (const m of messages) {
    if (m.role === "system") {
      if (m.content.trim()) system.push(m.content.trim());
    } else if (m.role === "tool") {
      pushUser([
        {
          type: "tool_result",
          tool_use_id: m.toolCallId ?? "",
          // An empty result is valid for a tool, but not as block content.
          content: m.content || "(no output)",
          ...(m.isError ? { is_error: true as const } : {}),
        },
      ]);
    } else if (m.role === "assistant") {
      const content = assistantContent(m);
      if (content !== null) turns.push({ role: "assistant", content });
    } else {
      if (!m.content.trim()) continue;
      const last = turns[turns.length - 1];
      // Text after tool results joins their message; otherwise a plain turn.
      if (last && last.role === "user" && Array.isArray(last.content)) {
        last.content.push({ type: "text", text: m.content });
      } else {
        turns.push({ role: "user", content: m.content });
      }
    }
  }
  return {
    system: system.length > 0 ? system.join("\n\n") : undefined,
    messages: turns,
  };
}

const TOOL_CHOICE = { auto: "auto", required: "any", none: "none" } as const;

/**
 * Body for `POST /messages`. `req.temperature` is deliberately not sent: API
 * version 2026-10-21 answers 400 to `temperature`, `top_p` and `top_k` on every
 * model, and under 2023-06-01 the models from Claude 4.7 on reject any value
 * but the default.
 */
export function buildMessagesPayload(
  req: ChatRequest,
  opts: { stream: boolean },
): AnthropicMessagesPayload {
  const { system, messages } = toAnthropicMessages(req.messages);
  if (messages.length === 0) {
    throw Errors.badRequest(
      "An Anthropic request needs at least one user or assistant message",
    );
  }
  const payload: AnthropicMessagesPayload = {
    model: req.model,
    max_tokens: req.maxTokens ?? ANTHROPIC_MAX_TOKENS,
    ...(system ? { system } : {}),
    messages,
  };
  if (req.tools?.length) {
    payload.tools = req.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
    if (req.toolChoice) payload.tool_choice = { type: TOOL_CHOICE[req.toolChoice] };
  }
  if (opts.stream) payload.stream = true;
  return payload;
}

/** Path and query of one Models API page, relative to the base URL. */
export function modelsPath(opts: { limit: number; afterId?: string }): string {
  const query = new URLSearchParams({ limit: String(opts.limit) });
  if (opts.afterId) query.set("after_id", opts.afterId);
  return `/models?${query.toString()}`;
}

// ─── Response ─────────────────────────────────────────────────────────────────

interface WireUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

interface WireStopDetails {
  category?: string | null;
  explanation?: string | null;
}

interface WireBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  thinking?: string;
  signature?: string;
  data?: string;
}

interface WireMessage {
  content?: WireBlock[];
  stop_reason?: string | null;
  stop_details?: WireStopDetails | null;
  usage?: WireUsage | null;
}

interface WireError {
  type?: string;
  message?: string;
}

interface WireStreamEvent {
  type?: string;
  index?: number;
  message?: WireMessage;
  content_block?: WireBlock;
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    thinking?: string;
    signature?: string;
    stop_reason?: string | null;
    stop_details?: WireStopDetails | null;
  };
  usage?: WireUsage | null;
  error?: WireError;
}

interface UsageTally {
  input?: number;
  cacheCreation?: number;
  cacheRead?: number;
  output?: number;
}

function asObject<T>(value: unknown): T | null {
  return value !== null && typeof value === "object" ? (value as T) : null;
}

/** Counters are whole-message totals: overwrite the ones present, never add. */
function mergeUsage(tally: UsageTally, usage: WireUsage | null | undefined): void {
  if (!usage) return;
  if (typeof usage.input_tokens === "number") tally.input = usage.input_tokens;
  if (typeof usage.cache_creation_input_tokens === "number") {
    tally.cacheCreation = usage.cache_creation_input_tokens;
  }
  if (typeof usage.cache_read_input_tokens === "number") {
    tally.cacheRead = usage.cache_read_input_tokens;
  }
  if (typeof usage.output_tokens === "number") tally.output = usage.output_tokens;
}

/** Anthropic reports no total, and counts cached input separately. */
function toChatUsage(tally: UsageTally): ChatUsage | undefined {
  const promptTokens =
    tally.input === undefined
      ? undefined
      : tally.input + (tally.cacheCreation ?? 0) + (tally.cacheRead ?? 0);
  const completionTokens = tally.output;
  if (promptTokens === undefined && completionTokens === undefined) return undefined;
  return {
    promptTokens,
    completionTokens,
    totalTokens:
      promptTokens !== undefined && completionTokens !== undefined
        ? promptTokens + completionTokens
        : undefined,
  };
}

/**
 * A refusal is a normal 200 response whose content, if any, is to be discarded.
 * Raised as an error so the reason is shown instead of an empty reply, and so
 * the orchestrator moves on to its next candidate model.
 */
function refusalError(details: WireStopDetails | null | undefined): AppError {
  const category = typeof details?.category === "string" ? details.category : "";
  const explanation =
    typeof details?.explanation === "string" ? details.explanation.trim() : "";
  const detail = [category ? `[${category}]` : "", explanation]
    .filter(Boolean)
    .join(" ");
  return new AppError(
    422,
    "upstream_refusal",
    detail
      ? `The model declined this request: ${sanitizeUpstreamError(detail)}`
      : "The model declined this request",
  );
}

/** Parse a non-streaming `POST /messages` response. */
export function parseMessageResponse(json: unknown): ChatResult {
  const message = asObject<WireMessage>(json);
  if (!message || !Array.isArray(message.content)) {
    throw new AppError(
      502,
      "upstream_error",
      "Provider returned a response that is not an Anthropic message",
    );
  }
  const stopReason = message.stop_reason ?? undefined;
  if (stopReason === "refusal") throw refusalError(message.stop_details);

  const tally: UsageTally = {};
  mergeUsage(tally, message.usage);
  return fromBlocks(message.content, stopReason, toChatUsage(tally));
}

/** The tool calls among a message's blocks. */
function toolCallsOf(blocks: WireBlock[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const block of blocks) {
    if (block?.type !== "tool_use" || typeof block.name !== "string" || !block.name) continue;
    const input = asObject<Record<string, unknown>>(block.input);
    calls.push({
      id: typeof block.id === "string" && block.id ? block.id : `toolu_${calls.length}`,
      name: block.name,
      arguments: input && !Array.isArray(input) ? input : {},
    });
  }
  return calls;
}

/**
 * A reply from its content blocks. Only text blocks are the visible reply.
 * When the model called tools, the blocks are kept as `raw`, because the next
 * request has to return this turn's thinking blocks unchanged.
 */
function fromBlocks(
  blocks: WireBlock[],
  stopReason: string | undefined,
  usage: ChatUsage | undefined,
): ChatResult {
  const content = blocks
    .map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : ""))
    .join("");
  const result: ChatResult = { content, finishReason: stopReason, usage };
  const toolCalls = toolCallsOf(blocks);
  if (toolCalls.length > 0) {
    result.toolCalls = toolCalls;
    result.raw = { adapter: ANTHROPIC_ADAPTER_ID, content: echoBlocks(blocks) };
  }
  return result;
}

/** Model ids of one Models API page, and the cursor of the next page if any. */
export function parseModelsPage(json: unknown): {
  ids: string[];
  nextAfterId?: string;
} {
  const page =
    asObject<{ data?: unknown; models?: unknown; has_more?: unknown; last_id?: unknown }>(
      json,
    ) ?? {};
  const list: unknown[] = Array.isArray(page.data)
    ? page.data
    : Array.isArray(page.models)
      ? page.models
      : [];
  const ids: string[] = [];
  for (const item of list) {
    const id = asObject<{ id?: unknown }>(item)?.id;
    if (typeof id === "string" && id) ids.push(id);
  }
  const nextAfterId =
    page.has_more === true && typeof page.last_id === "string" && page.last_id
      ? page.last_id
      : undefined;
  return { ids, nextAfterId };
}

/** Message for a non-2xx response; prefers the API's own `error.message`. */
export function upstreamErrorMessage(
  status: number,
  body: string,
  statusText = "",
): string {
  let detail = body.trim() || statusText || "Unknown upstream error";
  try {
    const error = asObject<{ error?: unknown }>(JSON.parse(body))?.error;
    const message = asObject<WireError>(error)?.message;
    if (typeof message === "string" && message) detail = message;
  } catch {
    /* not JSON: keep the raw body */
  }
  return `Provider responded ${status}: ${sanitizeUpstreamError(detail)}`;
}

// ─── Streaming ────────────────────────────────────────────────────────────────

export interface SseEvent {
  /** The `event:` field, or null when the event has none. */
  event: string | null;
  /** The `data:` lines, joined with newlines. */
  data: string;
}

/**
 * Incremental server-sent event parser. Network chunks end anywhere, including
 * inside a line or between the two bytes of a CRLF, so text is buffered until
 * a line is complete.
 */
export function createSseParser(): {
  push(chunk: string): SseEvent[];
  flush(): SseEvent[];
} {
  let buffer = "";
  let event: string | null = null;
  let data: string[] = [];

  const dispatch = (): SseEvent | null => {
    const done = data.length > 0 ? { event, data: data.join("\n") } : null;
    event = null;
    data = [];
    return done;
  };

  const consume = (lines: string[]): SseEvent[] => {
    const events: SseEvent[] = [];
    for (const line of lines) {
      if (line === "") {
        const done = dispatch();
        if (done) events.push(done);
        continue;
      }
      if (line.startsWith(":")) continue; // comment, used as keep-alive
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    return events;
  };

  return {
    push(chunk) {
      buffer += chunk;
      // A trailing "\r" may be the first half of "\r\n": keep it for later.
      const held = buffer.endsWith("\r") ? "\r" : "";
      const lines = (held ? buffer.slice(0, -1) : buffer).split(/\r\n|\n|\r/);
      buffer = (lines.pop() ?? "") + held;
      return consume(lines);
    },
    /** Call once at the end of the stream; emits an unterminated last event. */
    flush() {
      const rest = buffer;
      buffer = "";
      const events = rest ? consume(rest.split(/\r\n|\n|\r/)) : [];
      const last = dispatch();
      if (last) events.push(last);
      return events;
    },
  };
}

/**
 * Fold the events of a streamed message into one result. Text deltas are
 * forwarded to `onDelta` as they arrive. Thinking and tool-call blocks are put
 * together from their deltas and returned with the result; event types this
 * code does not know are skipped.
 */
export function createMessageStream(onDelta: (text: string) => void): {
  handle(event: SseEvent): void;
  result(): ChatResult;
} {
  let stopReason: string | undefined;
  let stopDetails: WireStopDetails | null | undefined;
  let sawMessage = false;
  const tally: UsageTally = {};
  // Blocks by their index in the message, and the JSON text of tool inputs.
  const blocks = new Map<number, WireBlock>();
  const inputJson = new Map<number, string>();
  const blockAt = (index: number | undefined, type: string): WireBlock => {
    const key = index ?? 0;
    let block = blocks.get(key);
    if (!block) {
      block = { type };
      blocks.set(key, block);
    }
    return block;
  };

  return {
    handle(sse) {
      let chunk: WireStreamEvent | null = null;
      try {
        chunk = asObject<WireStreamEvent>(JSON.parse(sse.data));
      } catch {
        /* not JSON */
      }
      const type = chunk?.type ?? sse.event;

      if (type === "error") {
        // Sent in place of an HTTP error once the response has started.
        const detail = [chunk?.error?.type, chunk?.error?.message]
          .filter((s): s is string => typeof s === "string" && s.length > 0)
          .join(": ");
        throw new AppError(
          502,
          "upstream_error",
          `Provider stream error: ${sanitizeUpstreamError(detail || sse.data)}`,
        );
      }
      if (!chunk) return;

      switch (type) {
        case "message_start":
          sawMessage = true;
          mergeUsage(tally, chunk.message?.usage);
          break;
        case "content_block_start": {
          sawMessage = true;
          const start = chunk.content_block;
          if (start && typeof start.type === "string") {
            blocks.set(chunk.index ?? blocks.size, { ...start });
          }
          break;
        }
        case "content_block_delta": {
          sawMessage = true;
          const delta = chunk.delta;
          if (!delta) break;
          const kind = delta.type ?? "text_delta";
          if (kind === "text_delta" && typeof delta.text === "string" && delta.text) {
            const block = blockAt(chunk.index, "text");
            block.text = (block.text ?? "") + delta.text;
            onDelta(delta.text);
          } else if (kind === "input_json_delta" && typeof delta.partial_json === "string") {
            const key = chunk.index ?? 0;
            inputJson.set(key, (inputJson.get(key) ?? "") + delta.partial_json);
          } else if (kind === "thinking_delta" && typeof delta.thinking === "string") {
            const block = blockAt(chunk.index, "thinking");
            block.thinking = (block.thinking ?? "") + delta.thinking;
          } else if (kind === "signature_delta" && typeof delta.signature === "string") {
            const block = blockAt(chunk.index, "thinking");
            block.signature = (block.signature ?? "") + delta.signature;
          }
          break;
        }
        case "message_delta":
          sawMessage = true;
          mergeUsage(tally, chunk.usage);
          if (chunk.delta?.stop_reason) stopReason = chunk.delta.stop_reason;
          if (chunk.delta?.stop_details) stopDetails = chunk.delta.stop_details;
          break;
        case "message_stop":
          sawMessage = true;
          break;
        default:
          break;
      }
    },

    /** Call once the stream has ended. */
    result() {
      if (!sawMessage) {
        throw new AppError(
          502,
          "upstream_error",
          "Provider returned no message events in its stream",
        );
      }
      if (stopReason === "refusal") throw refusalError(stopDetails);
      const ordered = [...blocks.entries()].sort(([a], [b]) => a - b);
      for (const [index, block] of ordered) {
        if (block.type !== "tool_use") continue;
        const text = inputJson.get(index);
        if (!text) continue;
        try {
          block.input = JSON.parse(text) as unknown;
        } catch {
          block.input = {};
        }
      }
      return fromBlocks(
        ordered.map(([, block]) => block),
        stopReason,
        toChatUsage(tally),
      );
    },
  };
}
