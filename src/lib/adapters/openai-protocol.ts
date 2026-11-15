import type { Capability } from "@/lib/capabilities";
import { AppError, sanitizeUpstreamError } from "../errors";
import type {
  ChatMessage,
  ChatRequest,
  ChatResult,
  ChatUsage,
  EmbedResult,
  ListedModel,
  SpeechRequest,
  ToolCall,
} from "./types";

/**
 * Wire format of the OpenAI chat completions, embeddings and speech APIs, as
 * spoken by OpenAI-compatible providers. Pure: no network, env or server-only,
 * so it can be unit-tested. The I/O lives in ./openai.ts.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// ─── Requests ────────────────────────────────────────────────────────────────

/** Gateway messages as chat-completions messages. */
export function toOpenAiMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content };
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        // An assistant turn that only calls tools has no text.
        content: m.content ? m.content : null,
        tool_calls: m.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: call.invalidArguments ?? JSON.stringify(call.arguments ?? {}),
          },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

/** Body of `POST /chat/completions`. */
export function buildChatBody(req: ChatRequest, opts: { stream: boolean }): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: toOpenAiMessages(req.messages),
    stream: opts.stream,
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.tools?.length) {
    body.tools = req.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
    if (req.toolChoice) body.tool_choice = req.toolChoice;
  }
  if (opts.stream) body.stream_options = { include_usage: true };
  return body;
}

// ─── Responses ───────────────────────────────────────────────────────────────

function parseUsage(usage: unknown): ChatUsage | undefined {
  if (!isRecord(usage)) return undefined;
  const out: ChatUsage = {
    promptTokens: num(usage.prompt_tokens),
    completionTokens: num(usage.completion_tokens),
    totalTokens: num(usage.total_tokens),
  };
  return out.promptTokens === undefined &&
    out.completionTokens === undefined &&
    out.totalTokens === undefined
    ? undefined
    : out;
}

/**
 * The arguments of a tool call. They arrive as a JSON string; a few servers
 * send the object itself. Anything that is not a JSON object is kept as text
 * in `invalidArguments`, so the model can be told what it sent.
 */
export function parseToolArguments(raw: unknown): Pick<ToolCall, "arguments" | "invalidArguments"> {
  if (isRecord(raw)) return { arguments: raw };
  if (raw === undefined || raw === null || raw === "") return { arguments: {} };
  if (typeof raw !== "string") return { arguments: {}, invalidArguments: JSON.stringify(raw) };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) return { arguments: parsed };
    if (parsed === null) return { arguments: {} };
  } catch {
    /* fall through */
  }
  return { arguments: {}, invalidArguments: raw };
}

function parseToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: ToolCall[] = [];
  raw.forEach((item, index) => {
    if (!isRecord(item) || !isRecord(item.function)) return;
    const name = typeof item.function.name === "string" ? item.function.name : "";
    if (!name) return;
    calls.push({
      id: typeof item.id === "string" && item.id ? item.id : `call_${index}`,
      name,
      ...parseToolArguments(item.function.arguments),
    });
  });
  return calls;
}

/** Text of a message whose content is a string or a list of parts. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      isRecord(part) && (part.type === "text" || part.type === undefined) && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("");
}

function errorInBody(json: unknown): string | undefined {
  if (!isRecord(json)) return undefined;
  const err = json.error;
  if (typeof err === "string" && err) return err;
  if (isRecord(err)) {
    if (typeof err.message === "string" && err.message) return err.message;
    if (typeof err.code === "string" && err.code) return err.code;
  }
  return undefined;
}

/** Parse a non-streaming `POST /chat/completions` response. */
export function parseChatResponse(json: unknown): ChatResult {
  const choices = isRecord(json) && Array.isArray(json.choices) ? json.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : null;
  if (!choice) {
    // Some gateways answer 200 with an error object instead of choices.
    const detail = errorInBody(json);
    throw new AppError(
      502,
      "upstream_error",
      detail
        ? `Provider error: ${sanitizeUpstreamError(detail)}`
        : "Provider returned a response without choices",
    );
  }
  const message = isRecord(choice.message) ? choice.message : {};
  const toolCalls = parseToolCalls(message.tool_calls);
  const result: ChatResult = {
    content: contentText(message.content),
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : undefined,
    usage: parseUsage(isRecord(json) ? json.usage : undefined),
  };
  if (toolCalls.length > 0) result.toolCalls = toolCalls;
  return result;
}

interface PartialToolCall {
  id: string;
  name: string;
  args: string;
}

/**
 * Fold the `data:` payloads of a streamed completion into one result. Text is
 * forwarded to `onDelta` as it arrives; tool calls arrive in pieces, keyed by
 * index, and are put together for the result.
 */
export function createChatStream(onDelta: (text: string) => void): {
  handle(payload: string): void;
  result(): ChatResult;
} {
  let content = "";
  let usage: ChatUsage | undefined;
  let finishReason: string | undefined;
  const calls = new Map<number, PartialToolCall>();

  return {
    handle(payload) {
      if (payload === "[DONE]" || payload === "") return;
      let chunk: unknown;
      try {
        chunk = JSON.parse(payload);
      } catch {
        return; // keep-alive or malformed line
      }
      if (!isRecord(chunk)) return;

      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      const choice = isRecord(choices[0]) ? choices[0] : null;
      if (!choice) {
        const detail = errorInBody(chunk);
        if (detail) {
          throw new AppError(502, "upstream_error", `Provider stream error: ${sanitizeUpstreamError(detail)}`);
        }
      }
      const delta = choice && isRecord(choice.delta) ? choice.delta : null;
      if (delta) {
        const text = contentText(delta.content);
        if (text) {
          content += text;
          onDelta(text);
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const piece of delta.tool_calls) {
            if (!isRecord(piece)) continue;
            const index = num(piece.index) ?? calls.size;
            const call = calls.get(index) ?? { id: "", name: "", args: "" };
            if (typeof piece.id === "string" && piece.id) call.id = piece.id;
            if (isRecord(piece.function)) {
              if (typeof piece.function.name === "string") call.name += piece.function.name;
              if (typeof piece.function.arguments === "string") call.args += piece.function.arguments;
            }
            calls.set(index, call);
          }
        }
      }
      if (choice && typeof choice.finish_reason === "string" && choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
      const chunkUsage = parseUsage(chunk.usage);
      if (chunkUsage) usage = chunkUsage;
    },

    result() {
      const toolCalls: ToolCall[] = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .filter(([, call]) => call.name)
        .map(([index, call]) => ({
          id: call.id || `call_${index}`,
          name: call.name,
          ...parseToolArguments(call.args),
        }));
      const result: ChatResult = { content, usage, finishReason };
      if (toolCalls.length > 0) result.toolCalls = toolCalls;
      return result;
    },
  };
}

// ─── Models ──────────────────────────────────────────────────────────────────

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * The model list. Plain OpenAI lists carry ids only. OpenRouter-style lists
 * also say what each model takes and returns, which is read here so that an
 * imported model does not have to be classified by hand.
 */
export function parseModelList(json: unknown): ListedModel[] {
  const data = isRecord(json) && Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : [];
  const out: ListedModel[] = [];
  for (const item of data) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id) continue;
    const listed: ListedModel = { id: item.id };
    if (typeof item.name === "string" && item.name && item.name !== item.id) {
      listed.displayName = item.name.slice(0, 120);
    }
    const context = num(item.context_length) ?? num(item.context_window);
    if (context && context > 0) listed.contextWindow = Math.round(context);

    const arch = isRecord(item.architecture) ? item.architecture : null;
    if (arch) {
      const inputs = strings(arch.input_modalities);
      const outputs = strings(arch.output_modalities);
      const params = strings(item.supported_parameters);
      const caps = new Set<Capability>();
      if (outputs.includes("text")) caps.add("text");
      if (outputs.includes("image")) caps.add("image_generation");
      if (outputs.includes("video")) caps.add("video_generation");
      if (outputs.includes("audio") && !outputs.includes("text")) caps.add("speech_generation");
      if (outputs.includes("embeddings")) caps.add("embeddings");
      if (caps.has("text")) {
        if (inputs.includes("image")) caps.add("vision");
        if (inputs.includes("audio")) caps.add("audio");
        if (params.includes("tools")) caps.add("tool_calling");
        if (params.includes("reasoning") || params.includes("include_reasoning")) caps.add("reasoning");
        if (params.includes("structured_outputs") || params.includes("response_format")) {
          caps.add("structured_output");
        }
      }
      if (caps.size > 0) listed.capabilities = [...caps];
    }
    out.push(listed);
  }
  return out;
}

// ─── Embeddings ──────────────────────────────────────────────────────────────

export function buildEmbeddingsBody(req: {
  model: string;
  input: string[];
  dimensions?: number;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    input: req.input,
    encoding_format: "float",
  };
  if (req.dimensions) body.dimensions = req.dimensions;
  return body;
}

/** Parse `POST /embeddings`: one vector per input, in input order. */
export function parseEmbeddingsResponse(json: unknown, expected: number): EmbedResult {
  const data = isRecord(json) && Array.isArray(json.data) ? json.data : null;
  if (!data) {
    const detail = errorInBody(json);
    throw new AppError(
      502,
      "upstream_error",
      detail
        ? `Provider error: ${sanitizeUpstreamError(detail)}`
        : "Provider returned a response without embeddings",
    );
  }
  const vectors: number[][] = new Array<number[]>(expected);
  data.forEach((item, position) => {
    if (!isRecord(item) || !Array.isArray(item.embedding)) return;
    const index = num(item.index) ?? position;
    if (index < 0 || index >= expected) return;
    const vector = item.embedding.filter((v): v is number => typeof v === "number");
    if (vector.length === item.embedding.length && vector.length > 0) vectors[index] = vector;
  });
  for (let i = 0; i < expected; i++) {
    if (!vectors[i]) {
      throw new AppError(502, "upstream_error", "Provider returned fewer embeddings than texts");
    }
  }
  const usage = isRecord(json) && isRecord(json.usage) ? json.usage : null;
  return {
    vectors,
    promptTokens: usage ? (num(usage.prompt_tokens) ?? num(usage.total_tokens)) : undefined,
  };
}

// ─── Speech ──────────────────────────────────────────────────────────────────

/** Body of `POST /audio/speech`. The answer is the audio file itself. */
export function buildSpeechBody(req: SpeechRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    input: req.input,
    voice: req.voice?.trim() || "alloy",
    response_format: req.format ?? "mp3",
  };
  if (req.speed !== undefined && req.speed !== 1) body.speed = req.speed;
  if (req.instructions?.trim()) body.instructions = req.instructions.trim();
  return body;
}
