import "server-only";
import { AppError, sanitizeUpstreamError } from "../errors";
import { safeFetch } from "../http-client";
import { MAX_IMAGE_BYTES } from "../media/files";
import { readBodyCapped } from "../media/http";
import {
  buildImageRequest,
  buildVideoRequest,
  isValidJobId,
  linkDownloadPlan,
  parseImageResponse,
  parseVideoJob,
  resolveMediaApi,
  videoDownloadPlan,
  videoStatusPath,
  type ParsedVideoJob,
} from "./media-protocol";
import type {
  ChatRequest,
  ChatResult,
  ListedModel,
  MediaDownload,
  ProviderAdapter,
  ProviderContext,
} from "./types";

function base(ctx: ProviderContext): string {
  return ctx.baseUrl.replace(/\/+$/, "");
}

function headers(ctx: ProviderContext): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
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
    detail = await res.text();
  } catch {
    /* ignore */
  }
  throw new AppError(
    res.status === 401 || res.status === 403 ? 502 : 502,
    "upstream_error",
    `Provider responded ${res.status}: ${sanitizeUpstreamError(detail || res.statusText)}`,
  );
}

/** Largest JSON answer accepted from a job endpoint (create / status). */
const JOB_JSON_MAX_BYTES = 1024 * 1024;
/** How long an answer body may take to arrive once its headers are in. */
const BODY_TIMEOUT_MS = 120_000;

/** A provider error that also says the job is gone (404 / 410). */
async function readJobError(res: Response): Promise<never> {
  if (res.status !== 404 && res.status !== 410) return readError(res);
  let detail = "";
  try {
    detail = await res.text();
  } catch {
    /* ignore */
  }
  throw new AppError(
    502,
    "upstream_not_found",
    `Provider responded ${res.status}: ${sanitizeUpstreamError(detail || res.statusText)}`,
  );
}

async function readJson(res: Response, maxBytes: number): Promise<unknown> {
  const raw = await readBodyCapped(res, { maxBytes, timeoutMs: BODY_TIMEOUT_MS });
  try {
    return JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    throw new AppError(502, "upstream_error", "Provider returned a response that is not JSON");
  }
}

/** Credentials and extra headers, for a request without a JSON body. */
function authHeaders(ctx: ProviderContext): Record<string, string> {
  const h = headers(ctx);
  delete h["content-type"];
  return h;
}

function toDownload(ctx: ProviderContext, plan: { url: string; withAuth: boolean }): MediaDownload {
  return { ...plan, authHeaders: plan.withAuth ? authHeaders(ctx) : {} };
}

export const openAiCompatibleAdapter: ProviderAdapter = {
  id: "openai-compatible",
  label: "OpenAI-compatible API",
  supports: [
    "text",
    "reasoning",
    "tool_calling",
    "structured_output",
    "vision",
    "streaming",
    "image_generation",
    "video_generation",
  ],
  canDiscoverModels: true,

  async listModels(ctx): Promise<ListedModel[]> {
    const res = await safeFetch(
      `${base(ctx)}/models`,
      { method: "GET", headers: headers(ctx) },
      { timeoutMs: ctx.timeoutMs, allowHosts: ctx.allowHosts },
    );
    if (!res.ok) await readError(res);
    const json = (await res.json()) as { data?: { id?: string }[] };
    const data = Array.isArray(json.data) ? json.data : [];
    return data
      .filter((m): m is { id: string } => typeof m.id === "string")
      .map((m) => ({ id: m.id }));
  },

  async testConnection(ctx): Promise<void> {
    const res = await safeFetch(
      `${base(ctx)}/models`,
      { method: "GET", headers: headers(ctx) },
      { timeoutMs: ctx.timeoutMs, allowHosts: ctx.allowHosts },
    );
    if (!res.ok) await readError(res);
  },

  async chat(ctx, req: ChatRequest): Promise<ChatResult> {
    const res = await safeFetch(
      `${base(ctx)}/chat/completions`,
      {
        method: "POST",
        headers: headers(ctx),
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          temperature: req.temperature,
          stream: false,
        }),
      },
      { timeoutMs: ctx.timeoutMs, allowHosts: ctx.allowHosts },
    );
    if (!res.ok) await readError(res);
    const json = (await res.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };
    const choice = json.choices?.[0];
    return {
      content: choice?.message?.content ?? "",
      finishReason: choice?.finish_reason,
      usage: json.usage
        ? {
            promptTokens: json.usage.prompt_tokens,
            completionTokens: json.usage.completion_tokens,
            totalTokens: json.usage.total_tokens,
          }
        : undefined,
    };
  },

  async chatStream(ctx, req, onDelta): Promise<ChatResult> {
    const res = await safeFetch(
      `${base(ctx)}/chat/completions`,
      {
        method: "POST",
        headers: headers(ctx),
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          temperature: req.temperature,
          stream: true,
          stream_options: { include_usage: true },
        }),
      },
      { timeoutMs: ctx.timeoutMs, allowHosts: ctx.allowHosts },
    );
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

    const handleData = (payload: string) => {
      if (payload === "[DONE]") return;
      try {
        const chunk = JSON.parse(payload) as {
          choices?: {
            delta?: { content?: string };
            finish_reason?: string | null;
          }[];
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
          } | null;
        };
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          content += delta;
          onDelta(delta);
        }
        const fr = chunk.choices?.[0]?.finish_reason;
        if (fr) finishReason = fr;
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
          };
        }
      } catch {
        /* ignore malformed keep-alive lines */
      }
    };

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data:")) {
          handleData(trimmed.slice(5).trim());
        }
      }
    }
    if (buffer.trim().startsWith("data:")) {
      handleData(buffer.trim().slice(5).trim());
    }

    return { content, usage, finishReason };
  },

  // ── Media. The request style depends on the provider: see media-protocol.ts.

  async generateImages(ctx, req, opts) {
    const wire = buildImageRequest(resolveMediaApi(ctx.mediaApi, ctx.baseUrl), req);
    const res = await safeFetch(
      `${base(ctx)}${wire.path}`,
      { method: "POST", headers: headers(ctx), body: JSON.stringify(wire.body) },
      { timeoutMs: opts.timeoutMs, allowHosts: ctx.allowHosts },
    );
    if (!res.ok) await readError(res);
    // Images usually arrive as base64 inside the JSON, a third larger than the file.
    const count = Math.max(1, req.n ?? 1);
    const maxBytes = count * Math.ceil(MAX_IMAGE_BYTES * 1.4) + JOB_JSON_MAX_BYTES;
    return parseImageResponse(await readJson(res, maxBytes));
  },

  async startVideo(ctx, req): Promise<ParsedVideoJob> {
    const wire = buildVideoRequest(resolveMediaApi(ctx.mediaApi, ctx.baseUrl), req);
    const res = await safeFetch(
      `${base(ctx)}${wire.path}`,
      { method: "POST", headers: headers(ctx), body: JSON.stringify(wire.body) },
      { timeoutMs: ctx.timeoutMs, allowHosts: ctx.allowHosts },
    );
    if (!res.ok) await readError(res);
    return parseVideoJob(await readJson(res, JOB_JSON_MAX_BYTES));
  },

  async getVideo(ctx, jobId): Promise<ParsedVideoJob> {
    if (!isValidJobId(jobId)) {
      throw new AppError(502, "upstream_not_found", "The stored video job id is not valid");
    }
    const res = await safeFetch(
      `${base(ctx)}${videoStatusPath(jobId)}`,
      { method: "GET", headers: authHeaders(ctx) },
      { timeoutMs: ctx.timeoutMs, allowHosts: ctx.allowHosts },
    );
    if (!res.ok) await readJobError(res);
    return parseVideoJob(await readJson(res, JOB_JSON_MAX_BYTES));
  },

  mediaDownload(ctx, link): MediaDownload | null {
    const plan = linkDownloadPlan(ctx.baseUrl, link);
    return plan ? toDownload(ctx, plan) : null;
  },

  videoDownload(ctx, jobId, job): MediaDownload {
    return toDownload(ctx, videoDownloadPlan(ctx.baseUrl, jobId, job));
  },
};
