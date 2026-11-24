import "server-only";
import { db } from "@/db";
import { usageRecords, type Model } from "@/db/schema";
import { currentApiKeyId } from "./request-context";
import { chargeTokens } from "./tokens";

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
  kind?: "chat" | "test" | "embedding" | "image" | "video" | "speech" | "other";
  /**
   * The API key the work was requested with. Left out, it is the key of the
   * request being handled, if that came in with one.
   */
  apiKeyId?: string | null;
  promptTokens?: number;
  completionTokens?: number;
  estimatedCost?: number | null;
  status?: "ok" | "error";
  errorCode?: string;
  latencyMs?: number;
  /**
   * The tokens are on the account's balance already: work of many calls
   * counts each call as it is answered (countTokens), and is recorded once,
   * at its end.
   */
  counted?: boolean;
}

/**
 * Count tokens on an account's balance, without a usage record. For work of
 * many calls (an agent with tools): every call counts the moment it is
 * answered, so that whatever else the account does meanwhile is held to the
 * same balance, and what was used is counted when a later call fails. The
 * record of the work is written at its end, with `counted`.
 */
export function countTokens(userId: string | null | undefined, promptTokens: number, completionTokens: number): void {
  try {
    chargeTokens(userId, promptTokens, completionTokens);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[xiero-nexus] token count failed:", err);
  }
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
        apiKeyId: input.apiKeyId === undefined ? currentApiKeyId() : input.apiKeyId,
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
  // The account's balance: what its work used. A check of a model is the
  // installation's own, and a request that failed delivered nothing.
  const kind = input.kind ?? "chat";
  if (input.userId && kind !== "test" && (input.status ?? "ok") === "ok" && !input.counted) {
    countTokens(input.userId, prompt, completion);
  }
}
