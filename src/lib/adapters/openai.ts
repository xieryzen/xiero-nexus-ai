import "server-only";
import { AppError, sanitizeUpstreamError } from "../errors";
import { safeFetch } from "../http-client";
import { MAX_AUDIO_BYTES, MAX_IMAGE_BYTES, pcmFormatFromMime } from "../media/files";
import { readBodyCapped } from "../media/http";
import {
  buildImageRequest,
  buildVideoRequest,
  isValidJobId,
  linkDownloadPlan,
  parseImageResponse,
  parseVideoJob,
  resolveMediaApi,
  upstreamErrorText,
  videoDownloadPlan,
  videoStatusPath,
  type ParsedVideoJob,
} from "./media-protocol";
import {
  buildChatBody,
  buildEmbeddingsBody,
  buildSpeechBody,
  createChatStream,
  parseChatResponse,
  parseEmbeddingsResponse,
  parseModelList,
} from "./openai-protocol";
import type {
  ChatRequest,
  ChatResult,
  EmbedResult,
  ListedModel,
  MediaDownload,
  ProviderAdapter,
  ProviderContext,
  SpeechResult,
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
    502,
    "upstream_error",
    `Provider responded ${res.status}: ${sanitizeUpstreamError(detail || res.statusText)}`,
  );
}

/** Largest answer accepted for a chat completion or a model list. */
const CHAT_JSON_MAX_BYTES = 32 * 1024 * 1024;
/** Texts sent to the embeddings endpoint in one request. */
const EMBED_BATCH = 64;

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
    "embeddings",
    "image_generation",
    "video_generation",
    "speech_generation",
  ],
  canDiscoverModels: true,

  async listModels(ctx): Promise<ListedModel[]> {
    const res = await safeFetch(
      `${base(ctx)}/models`,
      { method: "GET", headers: headers(ctx) },
      { timeoutMs: ctx.timeoutMs, allowHosts: ctx.allowHosts },
    );
    if (!res.ok) await readError(res);
    return parseModelList(await readJson(res, CHAT_JSON_MAX_BYTES));
  },

  async testConnection(ctx): Promise<void> {
    const res = await safeFetch(
      `${base(ctx)}/models`,
      { method: "GET", headers: headers(ctx) },
      { timeoutMs: ctx.timeoutMs, allowHosts: ctx.allowHosts },
    );
    if (!res.ok) await readError(res);
    void res.body?.cancel().catch(() => undefined);
  },

  async chat(ctx, req: ChatRequest): Promise<ChatResult> {
    const res = await safeFetch(
      `${base(ctx)}/chat/completions`,
      {
        method: "POST",
        headers: headers(ctx),
        body: JSON.stringify(buildChatBody(req, { stream: false })),
      },
      { timeoutMs: ctx.timeoutMs, allowHosts: ctx.allowHosts },
    );
    if (!res.ok) await readError(res);
    return parseChatResponse(await readJson(res, CHAT_JSON_MAX_BYTES));
  },

  async chatStream(ctx, req, onDelta): Promise<ChatResult> {
    const res = await safeFetch(
      `${base(ctx)}/chat/completions`,
      {
        method: "POST",
        headers: headers(ctx),
        body: JSON.stringify(buildChatBody(req, { stream: true })),
      },
      { timeoutMs: ctx.timeoutMs, allowHosts: ctx.allowHosts },
    );
    if (!res.ok || !res.body) {
      if (!res.ok) await readError(res);
      throw new AppError(502, "upstream_error", "Provider returned no stream");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const stream = createChatStream(onDelta);
    let buffer = "";
    const feed = (line: string) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) stream.handle(trimmed.slice(5).trim());
    };

    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch {
          throw new AppError(502, "network_error", "Provider stream was interrupted");
        }
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) feed(line);
      }
      feed(buffer);
    } catch (err) {
      void reader.cancel().catch(() => undefined);
      throw err;
    }
    return stream.result();
  },

  async embed(ctx, req): Promise<EmbedResult> {
    const vectors: number[][] = [];
    let promptTokens: number | undefined;
    for (let i = 0; i < req.input.length; i += EMBED_BATCH) {
      const batch = req.input.slice(i, i + EMBED_BATCH);
      const res = await safeFetch(
        `${base(ctx)}/embeddings`,
        {
          method: "POST",
          headers: headers(ctx),
          body: JSON.stringify(
            buildEmbeddingsBody({ model: req.model, input: batch, dimensions: req.dimensions }),
          ),
        },
        { timeoutMs: ctx.timeoutMs, allowHosts: ctx.allowHosts },
      );
      if (!res.ok) await readError(res);
      const parsed = parseEmbeddingsResponse(await readJson(res, CHAT_JSON_MAX_BYTES), batch.length);
      vectors.push(...parsed.vectors);
      if (parsed.promptTokens !== undefined) promptTokens = (promptTokens ?? 0) + parsed.promptTokens;
    }
    return { vectors, promptTokens };
  },

  async generateSpeech(ctx, req, opts): Promise<SpeechResult> {
    const res = await safeFetch(
      `${base(ctx)}/audio/speech`,
      { method: "POST", headers: headers(ctx), body: JSON.stringify(buildSpeechBody(req)) },
      { timeoutMs: opts.timeoutMs, allowHosts: ctx.allowHosts },
    );
    if (!res.ok) await readError(res);
    const type = res.headers.get("content-type");
    const bytes = await readBodyCapped(res, { maxBytes: MAX_AUDIO_BYTES, timeoutMs: BODY_TIMEOUT_MS });
    if (type && /\bjson\b/i.test(type)) {
      // Not audio: an error that came with a success status, most likely.
      let detail: string | undefined;
      try {
        detail = upstreamErrorText(JSON.parse(bytes.toString("utf8")));
      } catch {
        /* not JSON after all */
      }
      throw new AppError(
        502,
        "upstream_error",
        detail ? `Provider error: ${sanitizeUpstreamError(detail)}` : "The provider answered without audio",
      );
    }
    // Bare samples are announced by the content type ("audio/pcm", "audio/L16;rate=24000").
    const pcm = pcmFormatFromMime(type);
    return pcm ? { bytes, pcm } : { bytes };
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
