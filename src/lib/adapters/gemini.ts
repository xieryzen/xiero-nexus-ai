import "server-only";
import { AppError } from "../errors";
import { safeFetch } from "../http-client";
import { MAX_AUDIO_BYTES, MAX_IMAGE_BYTES, pcmFormatFromMime } from "../media/files";
import { readBodyCapped } from "../media/http";
import { createSseParser } from "./anthropic-protocol";
import {
  GEMINI_EMBED_BATCH,
  GEMINI_MODELS_PAGE_SIZE,
  buildEmbedBody,
  buildGenerateBody,
  buildImageBody,
  buildSpeechBody,
  createGenerateStream,
  geminiBase,
  geminiHeaders,
  modelPath,
  modelsListPath,
  parseEmbedResponse,
  parseGenerateResponse,
  parseImageResponse,
  parseModelsPage,
  parseSpeechResponse,
  upstreamErrorMessage,
} from "./gemini-protocol";
import type { ParsedImageResponse } from "./media-protocol";
import type {
  ChatRequest,
  ChatResult,
  EmbedResult,
  ListedModel,
  ProviderAdapter,
  ProviderContext,
  SpeechResult,
} from "./types";

/** Stops model discovery if a server never ends its list. */
const MAX_MODEL_PAGES = 20;
const JSON_MAX_BYTES = 32 * 1024 * 1024;
const BODY_TIMEOUT_MS = 120_000;

function base(ctx: ProviderContext): string {
  return geminiBase(ctx.baseUrl);
}

function fetchOptions(ctx: ProviderContext, timeoutMs = ctx.timeoutMs) {
  return { timeoutMs, allowHosts: ctx.allowHosts };
}

async function readError(res: Response): Promise<never> {
  let body = "";
  try {
    body = await res.text();
  } catch {
    /* ignore */
  }
  throw new AppError(502, "upstream_error", upstreamErrorMessage(res.status, body, res.statusText));
}

async function readJson(res: Response, maxBytes = JSON_MAX_BYTES): Promise<unknown> {
  const raw = await readBodyCapped(res, { maxBytes, timeoutMs: BODY_TIMEOUT_MS });
  try {
    return JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    throw new AppError(502, "upstream_error", "Provider returned a response that is not JSON");
  }
}

async function post(
  ctx: ProviderContext,
  path: string,
  body: unknown,
  timeoutMs?: number,
): Promise<Response> {
  const res = await safeFetch(
    `${base(ctx)}${path}`,
    { method: "POST", headers: geminiHeaders(ctx), body: JSON.stringify(body) },
    fetchOptions(ctx, timeoutMs),
  );
  if (!res.ok) await readError(res);
  return res;
}

/**
 * Gemini API adapter (Google AI Studio). The Base URL is the API root with its
 * version, e.g. https://generativelanguage.googleapis.com/v1beta. The wire
 * format is in ./gemini-protocol.ts.
 */
export const geminiAdapter: ProviderAdapter = {
  id: "gemini",
  label: "Google Gemini",
  supports: [
    "text",
    "reasoning",
    "tool_calling",
    "structured_output",
    "vision",
    "streaming",
    "embeddings",
    "image_generation",
    "speech_generation",
  ],
  canDiscoverModels: true,

  async listModels(ctx): Promise<ListedModel[]> {
    const byId = new Map<string, ListedModel>();
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_MODEL_PAGES; page++) {
      const res = await safeFetch(
        base(ctx) + modelsListPath({ pageSize: GEMINI_MODELS_PAGE_SIZE, pageToken }),
        { method: "GET", headers: geminiHeaders(ctx) },
        fetchOptions(ctx),
      );
      if (!res.ok) await readError(res);
      const parsed = parseModelsPage(await readJson(res));
      for (const model of parsed.models) byId.set(model.id, model);
      if (!parsed.nextPageToken || parsed.nextPageToken === pageToken) break;
      pageToken = parsed.nextPageToken;
    }
    return [...byId.values()];
  },

  async testConnection(ctx): Promise<void> {
    const res = await safeFetch(
      base(ctx) + modelsListPath({ pageSize: 1 }),
      { method: "GET", headers: geminiHeaders(ctx) },
      fetchOptions(ctx),
    );
    if (!res.ok) await readError(res);
    void res.body?.cancel().catch(() => undefined);
  },

  async chat(ctx, req: ChatRequest): Promise<ChatResult> {
    const res = await post(ctx, `${modelPath(req.model)}:generateContent`, buildGenerateBody(req));
    return parseGenerateResponse(await readJson(res));
  },

  async chatStream(ctx, req, onDelta): Promise<ChatResult> {
    const res = await post(
      ctx,
      `${modelPath(req.model)}:streamGenerateContent?alt=sse`,
      buildGenerateBody(req),
    );
    if (!res.body) throw new AppError(502, "upstream_error", "Provider returned no stream");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser();
    const stream = createGenerateStream(onDelta);
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch {
          throw new AppError(502, "network_error", "Provider stream was interrupted");
        }
        if (chunk.done) break;
        for (const event of parser.push(decoder.decode(chunk.value, { stream: true }))) {
          stream.handle(event.data);
        }
      }
      for (const event of [...parser.push(decoder.decode()), ...parser.flush()]) {
        stream.handle(event.data);
      }
    } catch (err) {
      void reader.cancel().catch(() => undefined);
      throw err;
    }
    return stream.result();
  },

  async embed(ctx, req): Promise<EmbedResult> {
    const vectors: number[][] = [];
    for (let i = 0; i < req.input.length; i += GEMINI_EMBED_BATCH) {
      const batch = req.input.slice(i, i + GEMINI_EMBED_BATCH);
      const res = await post(
        ctx,
        `${modelPath(req.model)}:batchEmbedContents`,
        buildEmbedBody({ model: req.model, input: batch, dimensions: req.dimensions }),
      );
      vectors.push(...parseEmbedResponse(await readJson(res), batch.length).vectors);
    }
    return { vectors };
  },

  /** One request per image: these models return one picture per answer. */
  async generateImages(ctx, req, opts): Promise<ParsedImageResponse> {
    const wanted = Math.max(1, req.n ?? 1);
    const out: ParsedImageResponse = { images: [] };
    const maxBytes = Math.ceil(MAX_IMAGE_BYTES * 1.4) + 1024 * 1024;
    for (let i = 0; i < wanted; i++) {
      const res = await post(
        ctx,
        `${modelPath(req.model)}:generateContent`,
        buildImageBody(req),
        opts.timeoutMs,
      );
      const parsed = parseImageResponse(await readJson(res, maxBytes));
      out.images.push(...parsed.images);
      if (parsed.inputTokens !== undefined) out.inputTokens = (out.inputTokens ?? 0) + parsed.inputTokens;
      if (parsed.outputTokens !== undefined) out.outputTokens = (out.outputTokens ?? 0) + parsed.outputTokens;
      if (parsed.error) out.error = parsed.error;
      if (parsed.images.length === 0) break; // refused: asking again changes nothing
    }
    return out;
  },

  async generateSpeech(ctx, req, opts): Promise<SpeechResult> {
    const res = await post(
      ctx,
      `${modelPath(req.model)}:generateContent`,
      buildSpeechBody(req),
      opts.timeoutMs,
    );
    const maxBytes = Math.ceil(MAX_AUDIO_BYTES * 1.4) + 1024 * 1024;
    const { b64, mimeType } = parseSpeechResponse(await readJson(res, maxBytes));
    const bytes = Buffer.from(b64, "base64");
    // The answer is bare samples ("audio/L16;codec=pcm;rate=24000").
    const pcm = pcmFormatFromMime(mimeType);
    return pcm ? { bytes, pcm } : { bytes };
  },
};
