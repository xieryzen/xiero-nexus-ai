import "server-only";
import { AppError } from "../errors";
import { safeFetch } from "../http-client";
import {
  ANTHROPIC_MODELS_PAGE_SIZE,
  anthropicHeaders,
  buildMessagesPayload,
  createMessageStream,
  createSseParser,
  modelsPath,
  parseMessageResponse,
  parseModelsPage,
  upstreamErrorMessage,
  type SseEvent,
} from "./anthropic-protocol";
import type {
  ChatRequest,
  ChatResult,
  ListedModel,
  ProviderAdapter,
  ProviderContext,
} from "./types";

/** Stops model discovery if a server never ends its list. */
const MAX_MODEL_PAGES = 20;

function base(ctx: ProviderContext): string {
  return ctx.baseUrl.replace(/\/+$/, "");
}

function fetchOptions(ctx: ProviderContext): { timeoutMs: number; allowHosts?: string[] } {
  return { timeoutMs: ctx.timeoutMs, allowHosts: ctx.allowHosts };
}

async function readError(res: Response): Promise<never> {
  let body = "";
  try {
    body = await res.text();
  } catch {
    /* ignore */
  }
  throw new AppError(
    502,
    "upstream_error",
    upstreamErrorMessage(res.status, body, res.statusText),
  );
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new AppError(
      502,
      "upstream_error",
      "Provider returned a response that is not JSON",
    );
  }
}

/**
 * Anthropic Messages API adapter. The base URL is the API root including its
 * version segment, e.g. https://api.anthropic.com/v1. The wire format is in
 * ./anthropic-protocol.ts.
 */
export const anthropicAdapter: ProviderAdapter = {
  id: "anthropic",
  label: "Anthropic",
  supports: ["text", "tool_calling", "structured_output", "vision", "streaming"],
  canDiscoverModels: true,

  async listModels(ctx): Promise<ListedModel[]> {
    const ids = new Set<string>();
    let afterId: string | undefined;
    for (let page = 0; page < MAX_MODEL_PAGES; page++) {
      const res = await safeFetch(
        base(ctx) + modelsPath({ limit: ANTHROPIC_MODELS_PAGE_SIZE, afterId }),
        { method: "GET", headers: anthropicHeaders(ctx) },
        fetchOptions(ctx),
      );
      if (!res.ok) await readError(res);
      const { ids: pageIds, nextAfterId } = parseModelsPage(await readJson(res));
      for (const id of pageIds) ids.add(id);
      if (!nextAfterId || nextAfterId === afterId) break;
      afterId = nextAfterId;
    }
    return [...ids].map((id) => ({ id }));
  },

  async testConnection(ctx): Promise<void> {
    const res = await safeFetch(
      base(ctx) + modelsPath({ limit: 1 }),
      { method: "GET", headers: anthropicHeaders(ctx) },
      fetchOptions(ctx),
    );
    if (!res.ok) await readError(res);
  },

  async chat(ctx, req: ChatRequest): Promise<ChatResult> {
    const res = await safeFetch(
      `${base(ctx)}/messages`,
      {
        method: "POST",
        headers: anthropicHeaders(ctx),
        body: JSON.stringify(buildMessagesPayload(req, { stream: false })),
      },
      fetchOptions(ctx),
    );
    if (!res.ok) await readError(res);
    return parseMessageResponse(await readJson(res));
  },

  async chatStream(ctx, req, onDelta): Promise<ChatResult> {
    const res = await safeFetch(
      `${base(ctx)}/messages`,
      {
        method: "POST",
        headers: anthropicHeaders(ctx),
        body: JSON.stringify(buildMessagesPayload(req, { stream: true })),
      },
      fetchOptions(ctx),
    );
    if (!res.ok || !res.body) {
      if (!res.ok) await readError(res);
      throw new AppError(502, "upstream_error", "Provider returned no stream");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser();
    const message = createMessageStream(onDelta);
    const feed = (events: SseEvent[]) => {
      for (const event of events) message.handle(event);
    };
    const read = async () => {
      try {
        return await reader.read();
      } catch {
        throw new AppError(502, "network_error", "Provider stream was interrupted");
      }
    };

    try {
      for (;;) {
        const { done, value } = await read();
        if (done) break;
        feed(parser.push(decoder.decode(value, { stream: true })));
      }
      feed(parser.push(decoder.decode()));
      feed(parser.flush());
    } catch (err) {
      // An error event or a dropped connection ends the reply: stop reading.
      void reader.cancel().catch(() => undefined);
      throw err;
    }
    return message.result();
  },
};
