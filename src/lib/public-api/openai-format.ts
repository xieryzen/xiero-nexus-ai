/**
 * The public API speaks the OpenAI wire format, so that existing clients and
 * SDKs work when they are pointed at this server. This module reads such
 * requests and writes such responses. Pure, so it can be unit-tested.
 */
import type { ChatMessage, ChatResult, ToolCall, ToolChoice, ToolDefinition } from "../adapters/types";

export class RequestError extends Error {
  constructor(
    message: string,
    public param?: string,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const MAX_API_MESSAGES = 400;
export const MAX_API_MESSAGE_CHARS = 400_000;
export const MAX_API_TOOLS = 64;

/** The text of a message: a string, or text parts. Pictures are not taken yet. */
function contentText(content: unknown, where: string): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") parts.push(part);
      else if (isRecord(part) && (part.type === "text" || part.type === "input_text") && typeof part.text === "string") {
        parts.push(part.text);
      } else {
        const type = isRecord(part) && typeof part.type === "string" ? part.type : "this";
        throw new RequestError(`${where}: content parts of type "${type}" are not supported; send text`, where);
      }
    }
    return parts.join("\n");
  }
  throw new RequestError(`${where}: content must be a string or an array of text parts`, where);
}

function parseToolCalls(value: unknown, where: string): ToolCall[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new RequestError(`${where}.tool_calls must be an array`, where);
  return value.map((raw, i) => {
    const fn = isRecord(raw) && isRecord(raw.function) ? raw.function : null;
    if (!isRecord(raw) || typeof raw.id !== "string" || !fn || typeof fn.name !== "string") {
      throw new RequestError(`${where}.tool_calls[${i}] needs an id and a function name`, where);
    }
    let args: Record<string, unknown> = {};
    let invalid: string | undefined;
    if (typeof fn.arguments === "string" && fn.arguments.trim()) {
      try {
        const parsed = JSON.parse(fn.arguments) as unknown;
        if (isRecord(parsed)) args = parsed;
        else invalid = fn.arguments;
      } catch {
        invalid = fn.arguments;
      }
    } else if (isRecord(fn.arguments)) {
      args = fn.arguments;
    }
    return { id: raw.id, name: fn.name, arguments: args, ...(invalid ? { invalidArguments: invalid } : {}) };
  });
}

export interface ParsedChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  stream: boolean;
  /** `stream_options.include_usage`: end the stream with a chunk that carries the usage. */
  includeUsage: boolean;
}

/** Read the body of POST /v1/chat/completions. Throws RequestError on a bad request. */
export function parseChatCompletionRequest(body: unknown): ParsedChatRequest {
  if (!isRecord(body)) throw new RequestError("The request body must be a JSON object");
  if (typeof body.model !== "string" || !body.model.trim()) {
    throw new RequestError("model is required", "model");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new RequestError("messages must be a non-empty array", "messages");
  }
  if (body.messages.length > MAX_API_MESSAGES) {
    throw new RequestError(`messages can hold at most ${MAX_API_MESSAGES} messages`, "messages");
  }
  if (body.n !== undefined && body.n !== null && body.n !== 1) {
    throw new RequestError("n must be 1: one answer is generated per request", "n");
  }

  const messages: ChatMessage[] = [];
  let chars = 0;
  body.messages.forEach((raw, i) => {
    const where = `messages[${i}]`;
    if (!isRecord(raw) || typeof raw.role !== "string") throw new RequestError(`${where} needs a role`, where);
    // "developer" is what newer clients call the system role.
    const role = raw.role === "developer" ? "system" : raw.role;
    const content = contentText(raw.content, where);
    chars += content.length;
    if (role === "system" || role === "user") {
      messages.push({ role, content });
    } else if (role === "assistant") {
      const toolCalls = parseToolCalls(raw.tool_calls, where);
      messages.push({ role, content, ...(toolCalls?.length ? { toolCalls } : {}) });
    } else if (role === "tool") {
      if (typeof raw.tool_call_id !== "string" || !raw.tool_call_id) {
        throw new RequestError(`${where}: a tool message needs tool_call_id`, where);
      }
      messages.push({
        role,
        content,
        toolCallId: raw.tool_call_id,
        ...(typeof raw.name === "string" ? { name: raw.name } : {}),
      });
    } else {
      throw new RequestError(`${where}: role "${raw.role}" is not supported`, where);
    }
  });
  if (chars > MAX_API_MESSAGE_CHARS) {
    throw new RequestError(`The messages are longer than ${MAX_API_MESSAGE_CHARS} characters in total`, "messages");
  }

  let tools: ToolDefinition[] | undefined;
  if (body.tools !== undefined && body.tools !== null) {
    if (!Array.isArray(body.tools)) throw new RequestError("tools must be an array", "tools");
    if (body.tools.length > MAX_API_TOOLS) {
      throw new RequestError(`At most ${MAX_API_TOOLS} tools can be given`, "tools");
    }
    tools = body.tools.map((raw, i) => {
      const fn = isRecord(raw) && isRecord(raw.function) ? raw.function : null;
      if (!isRecord(raw) || raw.type !== "function" || !fn || typeof fn.name !== "string") {
        throw new RequestError(`tools[${i}] must be a function with a name`, "tools");
      }
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(fn.name)) {
        throw new RequestError(`tools[${i}]: "${fn.name.slice(0, 80)}" is not a valid function name`, "tools");
      }
      return {
        name: fn.name,
        description: typeof fn.description === "string" ? fn.description : "",
        parameters: isRecord(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
      };
    });
    if (tools.length === 0) tools = undefined;
  }

  let toolChoice: ToolChoice | undefined;
  if (tools && body.tool_choice !== undefined && body.tool_choice !== null) {
    if (body.tool_choice === "auto" || body.tool_choice === "none" || body.tool_choice === "required") {
      toolChoice = body.tool_choice;
    } else if (isRecord(body.tool_choice)) {
      // A single named function cannot be forced through every provider; the
      // nearest that all of them have is that some tool must be called.
      toolChoice = "required";
    } else {
      throw new RequestError('tool_choice must be "auto", "none" or "required"', "tool_choice");
    }
  }

  const number = (value: unknown, name: string, min: number, max: number): number | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      throw new RequestError(`${name} must be a number from ${min} to ${max}`, name);
    }
    return value;
  };
  const maxTokens =
    number(body.max_completion_tokens, "max_completion_tokens", 1, 1_000_000) ??
    number(body.max_tokens, "max_tokens", 1, 1_000_000);

  return {
    model: body.model.trim(),
    messages,
    temperature: number(body.temperature, "temperature", 0, 2),
    maxTokens: maxTokens === undefined ? undefined : Math.floor(maxTokens),
    tools,
    toolChoice,
    stream: body.stream === true,
    includeUsage: isRecord(body.stream_options) && body.stream_options.include_usage === true,
  };
}

// ─── Responses ───────────────────────────────────────────────────────────────

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

function usageJson(usage: Usage) {
  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.promptTokens + usage.completionTokens,
  };
}

function toolCallsJson(calls: ToolCall[]) {
  return calls.map((call) => ({
    id: call.id,
    type: "function" as const,
    function: { name: call.name, arguments: call.invalidArguments ?? JSON.stringify(call.arguments) },
  }));
}

/** The reason a provider gave for stopping, in the words clients expect. */
export function finishReasonOf(result: Pick<ChatResult, "finishReason" | "toolCalls">): string {
  if (result.toolCalls?.length) return "tool_calls";
  const reason = (result.finishReason ?? "").toLowerCase();
  if (reason === "length" || reason === "max_tokens") return "length";
  if (reason === "content_filter" || reason === "safety") return "content_filter";
  return "stop";
}

export function formatChatCompletion(input: {
  id: string;
  created: number;
  model: string;
  result: ChatResult;
  usage: Usage;
}) {
  const calls = input.result.toolCalls ?? [];
  return {
    id: input.id,
    object: "chat.completion" as const,
    created: input.created,
    model: input.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant" as const,
          content: input.result.content || (calls.length ? null : ""),
          ...(calls.length ? { tool_calls: toolCallsJson(calls) } : {}),
        },
        finish_reason: finishReasonOf(input.result),
      },
    ],
    usage: usageJson(input.usage),
  };
}

/** One piece of a streamed answer. `delta` is what is new in it. */
export function formatChatChunk(input: {
  id: string;
  created: number;
  model: string;
  delta: { role?: "assistant"; content?: string; toolCalls?: ToolCall[] };
  finishReason?: string | null;
}) {
  const delta: Record<string, unknown> = {};
  if (input.delta.role) delta.role = input.delta.role;
  if (input.delta.content !== undefined) delta.content = input.delta.content;
  if (input.delta.toolCalls?.length) {
    delta.tool_calls = toolCallsJson(input.delta.toolCalls).map((call, index) => ({ index, ...call }));
  }
  return {
    id: input.id,
    object: "chat.completion.chunk" as const,
    created: input.created,
    model: input.model,
    choices: [{ index: 0, delta, finish_reason: input.finishReason ?? null }],
  };
}

/** The last piece of a stream when the client asked for the usage. */
export function formatUsageChunk(input: { id: string; created: number; model: string; usage: Usage }) {
  return {
    id: input.id,
    object: "chat.completion.chunk" as const,
    created: input.created,
    model: input.model,
    choices: [],
    usage: usageJson(input.usage),
  };
}

// ─── Embeddings ──────────────────────────────────────────────────────────────

export const MAX_EMBEDDING_INPUTS = 256;
export const MAX_EMBEDDING_INPUT_CHARS = 100_000;

export interface ParsedEmbeddingsRequest {
  model: string;
  input: string[];
  dimensions?: number;
  base64: boolean;
}

export function parseEmbeddingsRequest(body: unknown): ParsedEmbeddingsRequest {
  if (!isRecord(body)) throw new RequestError("The request body must be a JSON object");
  if (typeof body.model !== "string" || !body.model.trim()) throw new RequestError("model is required", "model");
  const raw = typeof body.input === "string" ? [body.input] : body.input;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new RequestError("input must be a string or a non-empty array of strings", "input");
  }
  if (raw.length > MAX_EMBEDDING_INPUTS) {
    throw new RequestError(`At most ${MAX_EMBEDDING_INPUTS} texts can be embedded per request`, "input");
  }
  const input = raw.map((item, i) => {
    if (typeof item !== "string") {
      throw new RequestError(`input[${i}] must be a string (arrays of tokens are not supported)`, "input");
    }
    if (!item) throw new RequestError(`input[${i}] is empty`, "input");
    if (item.length > MAX_EMBEDDING_INPUT_CHARS) {
      throw new RequestError(`input[${i}] is longer than ${MAX_EMBEDDING_INPUT_CHARS} characters`, "input");
    }
    return item;
  });
  let dimensions: number | undefined;
  if (body.dimensions !== undefined && body.dimensions !== null) {
    if (typeof body.dimensions !== "number" || !Number.isInteger(body.dimensions) || body.dimensions < 1 || body.dimensions > 20_000) {
      throw new RequestError("dimensions must be a whole number", "dimensions");
    }
    dimensions = body.dimensions;
  }
  if (body.encoding_format !== undefined && body.encoding_format !== "float" && body.encoding_format !== "base64") {
    throw new RequestError('encoding_format must be "float" or "base64"', "encoding_format");
  }
  return { model: body.model.trim(), input, dimensions, base64: body.encoding_format === "base64" };
}

/** A vector as base64 of its 32-bit floats, little-endian: what `encoding_format: "base64"` asks for. */
export function vectorToBase64(vector: number[]): string {
  const bytes = new Uint8Array(vector.length * 4);
  const view = new DataView(bytes.buffer);
  vector.forEach((value, i) => view.setFloat32(i * 4, value, true));
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

export function formatEmbeddings(input: {
  model: string;
  vectors: number[][];
  promptTokens: number;
  base64: boolean;
}) {
  return {
    object: "list" as const,
    data: input.vectors.map((vector, index) => ({
      object: "embedding" as const,
      index,
      embedding: input.base64 ? vectorToBase64(vector) : vector,
    })),
    model: input.model,
    usage: { prompt_tokens: input.promptTokens, total_tokens: input.promptTokens },
  };
}

// ─── Models ──────────────────────────────────────────────────────────────────

export interface ListableModel {
  rowId: string;
  modelId: string;
  providerName: string;
}

/**
 * The name each model is called by in the API: its own id when no other
 * enabled model has the same one, else "<provider name>/<model id>".
 */
export function publicModelNames(models: ListableModel[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const m of models) counts.set(m.modelId, (counts.get(m.modelId) ?? 0) + 1);
  const names = new Map<string, string>();
  for (const m of models) {
    names.set(m.rowId, (counts.get(m.modelId) ?? 0) > 1 ? `${m.providerName}/${m.modelId}` : m.modelId);
  }
  return names;
}

/**
 * Find the model a request names: by the name the API lists it under, by
 * "<provider name>/<model id>", by its own id when that is unambiguous, or by
 * its row id. Returns the row id, `null` when there is none, or `"ambiguous"`.
 */
export function findModel(models: ListableModel[], requested: string): string | null | "ambiguous" {
  const wanted = requested.trim();
  const byRow = models.find((m) => m.rowId === wanted);
  if (byRow) return byRow.rowId;
  const qualified = models.filter((m) => `${m.providerName}/${m.modelId}` === wanted);
  if (qualified.length === 1) return qualified[0]!.rowId;
  const byId = models.filter((m) => m.modelId === wanted);
  if (byId.length === 1) return byId[0]!.rowId;
  if (byId.length > 1 || qualified.length > 1) return "ambiguous";
  const folded = models.filter((m) => m.modelId.toLowerCase() === wanted.toLowerCase());
  return folded.length === 1 ? folded[0]!.rowId : folded.length > 1 ? "ambiguous" : null;
}
