import { handle, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { AppError, sanitizeUpstreamError } from "@/lib/errors";
import {
  gatewayChatStream,
  resolveEnabledModel,
} from "@/lib/gateway";
import type { ChatMessage } from "@/lib/adapters/types";
import { computeCost, estimateTokens, recordUsage } from "@/lib/usage";
import { chatRequestSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";
// Streaming can run longer than the default; allow up to 5 minutes.
export const maxDuration = 300;

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export const POST = handle(async (req) => {
  const user = requireUser();
  const body = await parseBody(req, chatRequestSchema);
  const resolved = resolveEnabledModel(body.modelRowId); // throws safe errors

  const messages: ChatMessage[] = [];
  if (body.systemPrompt?.trim()) {
    messages.push({ role: "system", content: body.systemPrompt.trim() });
  }
  for (const m of body.messages) messages.push({ role: m.role, content: m.content });

  const started = Date.now();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const safeEnqueue = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(sse(obj)));
        } catch {
          /* client disconnected */
        }
      };
      try {
        const result = await gatewayChatStream(
          resolved,
          messages,
          (delta) => safeEnqueue({ delta }),
          { temperature: body.temperature },
        );
        const promptTokens =
          result.usage?.promptTokens ??
          estimateTokens(messages.map((m) => m.content).join("\n"));
        const completionTokens =
          result.usage?.completionTokens ?? estimateTokens(result.content);

        recordUsage({
          userId: user.id,
          providerId: resolved.provider.id,
          modelRowId: resolved.model.id,
          kind: "chat",
          promptTokens,
          completionTokens,
          estimatedCost: computeCost(resolved.model, promptTokens, completionTokens),
          status: "ok",
          latencyMs: Date.now() - started,
        });

        safeEnqueue({
          done: true,
          finishReason: result.finishReason ?? null,
          usage: { promptTokens, completionTokens },
        });
      } catch (err) {
        const message =
          err instanceof AppError ? err.message : sanitizeUpstreamError(err);
        recordUsage({
          userId: user.id,
          providerId: resolved.provider.id,
          modelRowId: resolved.model.id,
          kind: "chat",
          status: "error",
          errorCode: err instanceof AppError ? err.code : "error",
          latencyMs: Date.now() - started,
        });
        safeEnqueue({ error: message });
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
});
