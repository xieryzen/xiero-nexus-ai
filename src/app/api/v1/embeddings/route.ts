import { NextResponse } from "next/server";
import { AppError, sanitizeUpstreamError } from "@/lib/errors";
import { gatewayEmbed, resolveEmbeddingModel } from "@/lib/gateway";
import { formatEmbeddings, parseEmbeddingsRequest } from "@/lib/public-api/openai-format";
import { readJsonBody, resolveApiModel, v1 } from "@/lib/public-api/server";
import { computeCost, estimateTokens, recordUsage } from "@/lib/usage";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Embeddings in the OpenAI format. */
export const POST = v1("embeddings", async (req, { caller }) => {
  const request = parseEmbeddingsRequest(await readJsonBody(req));
  const resolved = resolveEmbeddingModel(resolveApiModel(caller, request.model, "embeddings"));
  const started = Date.now();
  try {
    const result = await gatewayEmbed(resolved, request.input, { dimensions: request.dimensions });
    const promptTokens = result.promptTokens ?? estimateTokens(request.input.join("\n"));
    recordUsage({
      userId: caller.user.id,
      providerId: resolved.provider.id,
      modelRowId: resolved.model.id,
      kind: "embedding",
      promptTokens,
      estimatedCost: computeCost(resolved.model, promptTokens, 0),
      status: "ok",
      latencyMs: Date.now() - started,
    });
    return NextResponse.json(
      formatEmbeddings({ model: request.model, vectors: result.vectors, promptTokens, base64: request.base64 }),
    );
  } catch (err) {
    recordUsage({
      userId: caller.user.id,
      providerId: resolved.provider.id,
      modelRowId: resolved.model.id,
      kind: "embedding",
      status: "error",
      errorCode: err instanceof AppError ? err.code : "error",
      latencyMs: Date.now() - started,
    });
    throw err instanceof AppError ? err : new AppError(502, "upstream_error", sanitizeUpstreamError(err));
  }
});
