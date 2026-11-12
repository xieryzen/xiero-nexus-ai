import "server-only";
import { AppError, sanitizeUpstreamError } from "../errors";
import { safeFetch } from "../http-client";
import type {
  ChatRequest,
  ChatResult,
  ListedModel,
  ProviderAdapter,
  ProviderContext,
} from "./types";

function base(ctx: ProviderContext): string {
  return ctx.baseUrl.replace(/\/+$/, "");
}

function headers(ctx: ProviderContext): Record<string, string> {
  const h: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": ctx.apiVersion ?? "2023-06-01",
  };

  if (ctx.apiKey) {
    h.authorization = `Bearer ${ctx.apiKey}`;
  }

  for (const [k, v] of Object.entries(ctx.extraHeaders ?? {})) {
    h[k.toLowerCase()] = v;
  }

  return h;
}

async function readError(res: Response): Promise<never> {
  let detail = "";
  try {
    detail = await res.text();
  } catch {
    /* ignore */
  }

  let message = detail || res.statusText || "Unknown upstream error";
  try {
    const parsed = JSON.parse(detail) as { error?: { message?: string } };
    if (parsed?.error?.message) message = parsed.error.message;
  } catch {
    /* ignore */
  }

  throw new AppError(
    502,
    "upstream_error",
    `Provider responded ${res.status}: ${sanitizeUpstreamError(message)}`,
  );
}

function anthropicMessages(req: ChatRequest): { system?: string; messages: { role: "user" | "assistant"; content: string }[] } {
  const system = req.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n")
    .trim();

  const messages = req.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    }));

  return { system: system || undefined, messages };
}

export const anthropicAdapter: ProviderAdapter = {
  id: "anthropic",
  label: "Anthropic",
  supports: ["text", "tool_calling", "structured_output", "vision", "streaming"],
  canDiscoverModels: true,

  async listModels(ctx): Promise<ListedModel[]> {
    const res = await safeFetch(`${base(ctx)}/models`, {
      method: "GET",
      headers: headers(ctx),
    }, { timeoutMs: ctx.timeoutMs, allowHosts: ctx.allowHosts });
    if (!res.ok) await readError(res);

    const json = (await res.json()) as {
      data?: { id?: string }[];
      models?: { id?: string }[];
    };
    const data = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];

    return data
      .filter((m): m is { id: string } => typeof m.id === "string")
      .map((m) => ({ id: m.id }));
  },

  async testConnection(ctx): Promise<void> {
    const res = await safeFetch(`${base(ctx)}/models`, {
      method: "GET",
      headers: headers(ctx),
    }, { timeoutMs: ctx.timeoutMs, allowHosts: ctx.allowHosts });
    if (!res.ok) await readError(res);
  },

  async chat(ctx, req): Promise<ChatResult> {
    const { system, messages } = anthropicMessages(req);
    const payload = {
      model: req.model,
      max_tokens: 1024,
      ...(system ? { system } : {}),
      messages,
    };

    const res = await safeFetch(`${base(ctx)}/messages`, {
      method: "POST",
      headers: headers(ctx),
      body: JSON.stringify(payload),
    }, { timeoutMs: ctx.timeoutMs, allowHosts: ctx.allowHosts });

    if (!res.ok) await readError(res);

    const json = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      stop_reason?: string | null;
      usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
    };

    const content = (json.content ?? [])
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("");

    return {
      content,
      finishReason: json.stop_reason ?? undefined,
      usage: json.usage
        ? {
            promptTokens: json.usage.input_tokens,
            completionTokens: json.usage.output_tokens,
            totalTokens: json.usage.total_tokens,
          }
        : undefined,
    };
  },

  async chatStream(ctx, req, onDelta): Promise<ChatResult> {
    const { system, messages } = anthropicMessages(req);
    const payload = {
      model: req.model,
      max_tokens: 1024,
      stream: true,
      ...(system ? { system } : {}),
      messages,
    };

    const res = await safeFetch(`${base(ctx)}/messages`, {
      method: "POST",
      headers: headers(ctx),
      body: JSON.stringify(payload),
    }, { timeoutMs: ctx.timeoutMs, allowHosts: ctx.allowHosts });

    if (!res.ok || !res.body) {
      if (!res.ok) await readError(res);
      throw new AppError(502, "upstream_error", "Provider returned no stream");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let usage: ChatResult["usage"];
    let finishReason: string | undefined;

    const handleEventBlock = (block: string) => {
      const lines = block
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      const payloads = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean);

      for (const payload of payloads) {
        if (payload === "[DONE]") return;
        try {
          const chunk = JSON.parse(payload) as {
            type?: string;
            delta?: { type?: string; text?: string; stop_reason?: string | null };
            message?: { usage?: { input_tokens?: number; output_tokens?: number } };
            usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
            stop_reason?: string | null;
          };

          if (chunk.type === "message_start" && chunk.message?.usage) {
            usage = {
              promptTokens: chunk.message.usage.input_tokens,
              completionTokens: chunk.message.usage.output_tokens,
            };
          }

          if (chunk.type === "content_block_delta") {
            const deltaText = chunk.delta?.text;
            if (deltaText) {
              content += deltaText;
              onDelta(deltaText);
            }
          }

          if (chunk.type === "message_delta") {
            const nextUsage = chunk.usage ?? chunk.message?.usage;
            if (nextUsage) {
              usage = {
                promptTokens: nextUsage.input_tokens,
                completionTokens: nextUsage.output_tokens,
                totalTokens: nextUsage.total_tokens,
              };
            }
            if (chunk.delta?.stop_reason || chunk.stop_reason) {
              finishReason = chunk.delta?.stop_reason ?? chunk.stop_reason ?? undefined;
            }
          }

          if (chunk.type === "message_stop" && !finishReason) {
            finishReason = "stop";
          }
        } catch {
          /* ignore malformed keep-alive lines */
        }
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        if (block.trim()) handleEventBlock(block);
      }
    }

    if (buffer.trim()) handleEventBlock(buffer);

    return { content, usage, finishReason };
  },
};

export default anthropicAdapter;
