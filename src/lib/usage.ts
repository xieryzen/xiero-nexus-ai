import "server-only";
import { db } from "@/db";
import { usageRecords, type Model } from "@/db/schema";

/** Rough token estimate when a provider does not report usage (~4 chars/token). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Estimated cost from the model's price metadata, in the provider's currency
 * unit. Returns null when prices are unknown — callers must label cost as an
 * estimate and never present a fabricated figure.
 */
export function computeCost(
  model: Pick<Model, "inputPricePerMTok" | "outputPricePerMTok">,
  promptTokens: number,
  completionTokens: number,
): number | null {
  if (model.inputPricePerMTok == null && model.outputPricePerMTok == null) {
    return null;
  }
  const inRate = model.inputPricePerMTok ?? 0;
  const outRate = model.outputPricePerMTok ?? 0;
  return (promptTokens / 1_000_000) * inRate + (completionTokens / 1_000_000) * outRate;
}

export interface RecordUsageInput {
  userId?: string | null;
  providerId?: string | null;
  modelRowId?: string | null;
  kind?: "chat" | "test" | "embedding" | "other";
  promptTokens?: number;
  completionTokens?: number;
  estimatedCost?: number | null;
  status?: "ok" | "error";
  errorCode?: string;
  latencyMs?: number;
}

export function recordUsage(input: RecordUsageInput): void {
  const prompt = input.promptTokens ?? 0;
  const completion = input.completionTokens ?? 0;
  try {
    db.insert(usageRecords)
      .values({
        userId: input.userId ?? null,
        providerId: input.providerId ?? null,
        modelRowId: input.modelRowId ?? null,
        kind: input.kind ?? "chat",
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: prompt + completion,
        estimatedCost: input.estimatedCost ?? null,
        costIsEstimated: true,
        status: input.status ?? "ok",
        errorCode: input.errorCode,
        latencyMs: input.latencyMs,
      })
      .run();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[xiero-nexus] usage write failed:", err);
  }
}
