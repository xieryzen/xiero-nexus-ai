/**
 * Estimated cost of generated media, from the price metadata an administrator
 * set on the model. Pure. Returns null when no matching price is set, so that
 * callers never show a made-up figure.
 */

export interface MediaPrices {
  inputPricePerMTok: number | null;
  outputPricePerMTok: number | null;
  pricePerImage: number | null;
  pricePerSecond: number | null;
}

export interface ImageUsage {
  images: number;
  /** Token counts, when the provider bills images by the token and reports them. */
  inputTokens?: number;
  outputTokens?: number;
}

export function computeImageCost(model: MediaPrices, usage: ImageUsage): number | null {
  let cost: number | null = null;
  if (model.pricePerImage != null) {
    cost = usage.images * model.pricePerImage;
  }
  const hasTokens = usage.inputTokens != null || usage.outputTokens != null;
  const hasTokenPrice = model.inputPricePerMTok != null || model.outputPricePerMTok != null;
  if (hasTokens && hasTokenPrice) {
    cost =
      (cost ?? 0) +
      ((usage.inputTokens ?? 0) / 1_000_000) * (model.inputPricePerMTok ?? 0) +
      ((usage.outputTokens ?? 0) / 1_000_000) * (model.outputPricePerMTok ?? 0);
  }
  return cost;
}

export function computeVideoCost(
  model: Pick<MediaPrices, "pricePerSecond">,
  seconds: number | null | undefined,
): number | null {
  if (model.pricePerSecond == null || seconds == null || !(seconds > 0)) return null;
  return seconds * model.pricePerSecond;
}
