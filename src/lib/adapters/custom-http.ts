import "server-only";
import { AppError, sanitizeUpstreamError } from "../errors";
import { providerFetch } from "../http-client";
import { readBodyCapped } from "../media/http";
import {
  buildChatRequest,
  parseChatResponse,
  parseCustomHttpConfig,
  parseModelList,
} from "./custom-http-protocol";
import type {
  ChatRequest,
  ChatResult,
  ListedModel,
  ProviderAdapter,
  ProviderContext,
} from "./types";

const JSON_MAX_BYTES = 16 * 1024 * 1024;
const BODY_TIMEOUT_MS = 120_000;

function base(ctx: ProviderContext): string {
  return ctx.baseUrl.replace(/\/+$/, "");
}

function headers(ctx: ProviderContext, withBody: boolean): Record<string, string> {
  const h: Record<string, string> = { accept: "application/json" };
  if (withBody) h["content-type"] = "application/json";
  if (ctx.authType === "bearer" && ctx.apiKey) {
    h["authorization"] = `Bearer ${ctx.apiKey}`;
  } else if (ctx.authType === "header" && ctx.apiKey && ctx.authHeaderName) {
    h[ctx.authHeaderName.toLowerCase()] = ctx.apiKey;
  }
  for (const [k, v] of Object.entries(ctx.extraHeaders ?? {})) {
    h[k.toLowerCase()] = v;
  }
  return h;
}

async function readError(res: Response): Promise<never> {
  let detail = "";
  try {
    detail = (await readBodyCapped(res, { maxBytes: 64 * 1024, timeoutMs: 15_000 })).toString("utf8");
  } catch {
    /* ignore */
  }
  throw new AppError(
    502,
    "upstream_error",
    `Provider responded ${res.status}: ${sanitizeUpstreamError(detail || res.statusText)}`,
  );
}

async function readJson(res: Response): Promise<unknown> {
  const raw = await readBodyCapped(res, { maxBytes: JSON_MAX_BYTES, timeoutMs: BODY_TIMEOUT_MS });
  try {
    return JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    throw new AppError(502, "upstream_error", "Provider returned a response that is not JSON");
  }
}

async function get(ctx: ProviderContext, path: string): Promise<Response> {
  return providerFetch(
    `${base(ctx)}${path}`,
    { method: "GET", headers: headers(ctx, false) },
    { timeoutMs: ctx.timeoutMs, allowHosts: ctx.allowHosts },
  );
}

/**
 * Custom HTTP adapter: a JSON API described by the provider's configuration.
 * See ./custom-http-protocol.ts for the configuration and its placeholders.
 */
export const customHttpAdapter: ProviderAdapter = {
  id: "custom-http",
  label: "Custom HTTP",
  supports: ["text"],
  canDiscoverModels: true,

  async listModels(ctx): Promise<ListedModel[]> {
    const config = parseCustomHttpConfig(ctx.config);
    if (!config.models) {
      throw new AppError(
        400,
        "bad_request",
        'This provider\'s configuration has no "models" section, so its models cannot be listed. Add models by hand on the Models page.',
      );
    }
    const res = await get(ctx, config.models.path);
    if (!res.ok) await readError(res);
    return parseModelList(config, await readJson(res));
  },

  async testConnection(ctx): Promise<void> {
    const config = parseCustomHttpConfig(ctx.config);
    if (config.models) {
      const res = await get(ctx, config.models.path);
      if (!res.ok) await readError(res);
      parseModelList(config, await readJson(res));
      return;
    }
    // Without a list to read, all that can be checked is that the service
    // answers. Whether the request format is right shows in a model's Test.
    const res = await get(ctx, config.healthPath ?? "");
    void res.body?.cancel().catch(() => undefined);
    const limit = config.healthPath ? 400 : 500;
    if (res.status >= limit) {
      throw new AppError(502, "upstream_error", `Provider responded ${res.status}`);
    }
  },

  async chat(ctx, req: ChatRequest): Promise<ChatResult> {
    const config = parseCustomHttpConfig(ctx.config);
    const wire = buildChatRequest(config, req);
    const res = await providerFetch(
      `${base(ctx)}${wire.path}`,
      { method: wire.method, headers: headers(ctx, true), body: JSON.stringify(wire.body) },
      { timeoutMs: ctx.timeoutMs, allowHosts: ctx.allowHosts },
    );
    if (!res.ok) await readError(res);
    return parseChatResponse(config, await readJson(res));
  },

  /** Not streamed: the whole answer arrives as one piece. */
  async chatStream(ctx, req, onDelta): Promise<ChatResult> {
    const result = await this.chat(ctx, req);
    if (result.content) onDelta(result.content);
    return result;
  },
};
