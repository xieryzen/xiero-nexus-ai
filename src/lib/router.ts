/**
 * Automatic model routing (v1.3). Pure + testable: given the available models,
 * pick one by policy. Default policy is lowest cost (input+output price per
 * 1M tokens), optionally constrained to a required capability. Models without
 * price metadata rank after priced ones, then deterministically by id.
 */
export interface RoutableModel {
  id: string;
  inputPricePerMTok: number | null;
  outputPricePerMTok: number | null;
  capabilities: string[];
}

export function pickCheapestModel(
  models: RoutableModel[],
  requiredCapability?: string | null,
): string | null {
  const eligible = requiredCapability
    ? models.filter((m) => m.capabilities.includes(requiredCapability))
    : models.slice();
  if (eligible.length === 0) return null;

  const cost = (m: RoutableModel) =>
    (m.inputPricePerMTok ?? Number.POSITIVE_INFINITY) +
    (m.outputPricePerMTok ?? Number.POSITIVE_INFINITY);

  eligible.sort((a, b) => {
    const ca = cost(a);
    const cb = cost(b);
    if (ca !== cb) return ca - cb;
    return a.id.localeCompare(b.id);
  });
  return eligible[0]!.id;
}
