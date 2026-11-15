import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { AppError, sanitizeUpstreamError } from "@/lib/errors";
import { gatewayChat, gatewayChatStream, resolveChatModel } from "@/lib/gateway";
import {
  finishReasonOf,
  formatChatChunk,
  formatChatCompletion,
  formatUsageChunk,
  parseChatCompletionRequest,
} from "@/lib/public-api/openai-format";
import { readJsonBody, resolveApiModel, v1 } from "@/lib/public-api/server";
import { SSE_HEADERS } from "@/lib/run-bus";
import { computeCost, estimateTokens, recordUsage } from "@/lib/usage";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Chat completions in the OpenAI format, through any provider this server
 * has: `messages`, `tools`, `stream`. The model is named as GET /api/v1/models
 * lists it.
 */
export const POST = v1("chat", async (req, { caller }) => {
  const request = parseChatCompletionRequest(await readJsonBody(req));
  const resolved = resolveChatModel(resolveApiModel(caller, request.model, "chat"));
  const options = {
    temperature: request.temperature,
    tools: request.tools,
    toolChoice: request.toolChoice,
    maxTokens: request.maxTokens,
  };
  const id = `chatcmpl-${randomUUID().replace(/-/g, "")}`;
  const created = Math.floor(Date.now() / 1000);
  const started = Date.now();
  const promptText = request.messages.map((m) => m.content).join("\n");

  const record = (usage: { promptTokens: number; completionTokens: number } | null, errorCode?: string) =>
    recordUsage({
      userId: caller.user.id,
      providerId: resolved.provider.id,
      modelRowId: resolved.model.id,
      kind: "chat",
      promptTokens: usage?.promptTokens,
      completionTokens: usage?.completionTokens,
      estimatedCost: usage ? computeCost(resolved.model, usage.promptTokens, usage.completionTokens) : undefined,
      status: usage ? "ok" : "error",
      errorCode,
      latencyMs: Date.now() - started,
    });

  if (!request.stream) {
    try {
      const result = await gatewayChat(resolved, request.messages, options);
      const usage = {
        promptTokens: result.usage?.promptTokens ?? estimateTokens(promptText),
        completionTokens:
          result.usage?.completionTokens ??
          estimateTokens(result.content + JSON.stringify(result.toolCalls ?? "")),
      };
      record(usage);
      return NextResponse.json(formatChatCompletion({ id, created, model: request.model, result, usage }));
    } catch (err) {
      record(null, err instanceof AppError ? err.code : "error");
      throw err instanceof AppError ? err : new AppError(502, "upstream_error", sanitizeUpstreamError(err));
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`));
        } catch {
          /* the client went away */
        }
      };
      const chunk = (delta: Parameters<typeof formatChatChunk>[0]["delta"], finishReason?: string) =>
        send(formatChatChunk({ id, created, model: request.model, delta, finishReason }));
      try {
        chunk({ role: "assistant", content: "" });
        const result = await gatewayChatStream(
          resolved,
          request.messages,
          (text) => {
            if (text) chunk({ content: text });
          },
          options,
        );
        // Tool calls are not streamed by the providers' adapters: they come whole.
        if (result.toolCalls?.length) chunk({ toolCalls: result.toolCalls });
        chunk({}, finishReasonOf(result));
        const usage = {
          promptTokens: result.usage?.promptTokens ?? estimateTokens(promptText),
          completionTokens:
            result.usage?.completionTokens ??
            estimateTokens(result.content + JSON.stringify(result.toolCalls ?? "")),
        };
        record(usage);
        if (request.includeUsage) send(formatUsageChunk({ id, created, model: request.model, usage }));
      } catch (err) {
        record(null, err instanceof AppError ? err.code : "error");
        send({
          error: {
            message: err instanceof AppError ? err.message : sanitizeUpstreamError(err),
            type: "api_error",
            code: err instanceof AppError ? err.code : "upstream_error",
          },
        });
      } finally {
        send("[DONE]");
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
});
