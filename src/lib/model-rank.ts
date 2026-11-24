/**
 * The order of the models of one provider in a list: the highest and newest
 * first, the oldest last. Pure: used by the server, and tested alone.
 *
 * Nobody tells the app when a model came out, so the order is read from what
 * a model is called:
 *
 * 1. Models an owner put somewhere (`position`) come first, in that order.
 * 2. Then by family: the models of one line stay together ("claude", "gpt",
 *    "gemini", …), the well-known lines first, the others by name.
 * 3. Within a family, the newest model of each class comes first, the highest
 *    class first: fable before opus before sonnet before haiku, pro before
 *    flash before lite (sortModels).
 * 4. Then the models those took the place of, the highest version first: 5
 *    before 4.8 before 4.6; within a version the highest class first; then
 *    the dearer one, where both have a price; then the larger one (70B
 *    before 8B); then the later date in the name; then by name.
 *
 * It is a reading of names, and names change: where it is wrong, an owner
 * puts the model where it belongs, on the Models page.
 */

export interface RankedModel {
  /** The id the provider knows it by: "anthropic/claude-opus-4.5", "claude-sonnet-4-5-20250929". */
  modelId: string;
  /** What it is called on a page. */
  name: string;
  /** Where an owner put it among the models of its provider: the lowest first. Null: by its name. */
  position?: number | null;
  /** What a million tokens of output cost, where that is known. */
  outputPrice?: number | null;
}

export interface ModelRank {
  /** The line it belongs to: "claude", "gpt", "gemini". */
  family: string;
  /** Where its family stands among the families: the well-known first. */
  familyOrder: number;
  /** [major, minor]. [-1, 0]: its name holds no version. */
  version: [number, number];
  /** Its class within a version: 6 for the highest, 1 for the lowest, 3.5 without a word for it. */
  tier: number;
  /** Billions of parameters, where the name says so. */
  size: number;
  /** The date in its name as a number that grows with time, or 0. */
  date: number;
}

/** The lines a list starts with, in this order. Every other family follows by name. */
const FAMILIES = [
  "claude",
  "gpt",
  "o",
  "gemini",
  "gemma",
  "grok",
  "deepseek",
  "qwen",
  "kimi",
  "glm",
  "llama",
  "mistral",
  "codestral",
  "nova",
  "command",
  "phi",
];

/** Words that are a line of models wherever they stand in a name: "Meta-Llama-3_3" is a llama. */
const FAMILY_ANYWHERE = ["claude", "gemini", "gemma", "llama", "deepseek", "qwen", "mistral", "mixtral", "grok", "kimi"];

/** The class a word stands for. The lowest of the words in a name counts: "flash-lite" is a lite. */
const TIER_WORDS: Record<string, number> = {
  fable: 7,
  ultra: 6,
  max: 6,
  premier: 6,
  heavy: 6,
  opus: 5,
  pro: 5,
  large: 5,
  xl: 5,
  plus: 4,
  sonnet: 4,
  medium: 4,
  flash: 3,
  fast: 3,
  turbo: 3,
  small: 3,
  haiku: 3,
  mini: 2.5,
  lite: 2,
  light: 2,
  instant: 2,
  micro: 1.5,
  nano: 1.5,
  tiny: 1,
  xs: 1,
};

/** What a provider adds after a colon to say how a model is served, not which one it is. */
const SERVED = new Set(["free", "beta", "extended", "nitro", "floor", "exacto", "online", "thinking"]);

interface Token {
  text: string;
  kind: "word" | "number" | "size";
  /** A number: its parts. "4.5" is [4, 5]; "4" is [4]. */
  parts?: number[];
  /** A size: in billions of parameters. */
  billions?: number;
}

function tokensOf(modelId: string): Token[] {
  let id = modelId.trim().toLowerCase();
  // "anthropic/claude-opus-4.5": the vendor a gateway puts in front is not part of the name.
  const slash = id.lastIndexOf("/");
  if (slash >= 0) id = id.slice(slash + 1);
  const colon = id.lastIndexOf(":");
  if (colon >= 0 && SERVED.has(id.slice(colon + 1))) id = id.slice(0, colon);
  const out: Token[] = [];
  const pattern = /[a-z]+|\d+(?:\.\d+)*|\.\d+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(id))) {
    const text = match[0];
    if (/^[a-z]/.test(text)) {
      out.push({ text, kind: "word" });
      continue;
    }
    // "70b", "0.6b", "32k", "1m": how large it is or how much it reads, not which version it is.
    const next = id.slice(pattern.lastIndex, pattern.lastIndex + 2);
    const unit = /^[bkm](?![a-z])/.exec(next)?.[0]?.[0];
    if (unit) {
      pattern.lastIndex += 1;
      out.push({ text: text + unit, kind: "size", billions: unit === "b" ? Number(text) : undefined });
      continue;
    }
    out.push({ text, kind: "number", parts: text.split(".").map((part) => (part === "" ? 0 : Number(part))) });
  }
  return out;
}

/** A number that is a date or a build, not a version: "20250929", "2411", "0528", "001". */
function isDateLike(token: Token): boolean {
  if (token.kind !== "number" || token.text.includes(".")) return false;
  return token.text.length >= 4 || (token.text.length >= 2 && token.text.startsWith("0"));
}

function isYear(token: Token | undefined): boolean {
  return Boolean(token && token.kind === "number" && /^20\d\d$/.test(token.text));
}

export function rankOf(modelId: string): ModelRank {
  const tokens = tokensOf(modelId);
  const words = tokens.filter((t) => t.kind === "word").map((t) => t.text);
  const anywhere = FAMILY_ANYWHERE.find((name) => words.includes(name));
  let family = anywhere ?? words[0] ?? "";
  // "gpt-oss" is a line of its own: open weights, numbered by size, not by version.
  if (family === "gpt" && words.includes("oss")) family = "gpt-oss";
  const known = FAMILIES.indexOf(family);
  const familyOrder = known >= 0 ? known : FAMILIES.length;

  let version: [number, number] = [-1, 0];
  let date = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== "number") continue;
    // "08-2024", "12-2024": a month and a year.
    if (isYear(tokens[i + 1]) && token.parts!.length === 1 && token.parts![0]! <= 12) {
      date = Math.max(date, Number(tokens[i + 1]!.text) * 100 + token.parts![0]!);
      i++;
      continue;
    }
    if (isDateLike(token)) {
      // "20250929" → 20250929; "2411" → 202411; "0528" → 528: later is larger within one line of names.
      const value = Number(token.text);
      date = Math.max(date, token.text.length === 4 && !token.text.startsWith("0") ? 200000 + value : value);
      continue;
    }
    if (version[0] !== -1) continue;
    const major = token.parts![0]!;
    let minor = token.parts![1] ?? 0;
    // "4-5", "3_3": the part after the point, written apart.
    const after = tokens[i + 1];
    if (token.parts!.length === 1 && after && after.kind === "number" && !isDateLike(after) && !isYear(tokens[i + 2]) && after.parts!.length === 1 && after.parts![0]! < 100) {
      minor = after.parts![0]!;
      i++;
    }
    version = [major, minor];
  }
  // "latest" names whatever is newest of its line.
  if (version[0] === -1 && words.includes("latest")) version = [Number.MAX_SAFE_INTEGER, 0];

  const classes = words.map((word) => TIER_WORDS[word]).filter((value): value is number => value !== undefined);
  const tier = classes.length > 0 ? Math.min(...classes) : 3.5;
  const size = Math.max(0, ...tokens.filter((t) => t.kind === "size" && t.billions !== undefined).map((t) => t.billions!));
  return { family, familyOrder, version, tier, size, date };
}

/** The order of two models of one provider: negative when `a` stands above `b`. */
export function compareModels(a: RankedModel, b: RankedModel): number {
  const pa = a.position ?? null;
  const pb = b.position ?? null;
  if (pa !== null || pb !== null) {
    if (pa === null) return 1;
    if (pb === null) return -1;
    if (pa !== pb) return pa - pb;
  }
  const ra = rankOf(a.modelId);
  const rb = rankOf(b.modelId);
  if (ra.familyOrder !== rb.familyOrder) return ra.familyOrder - rb.familyOrder;
  if (ra.family !== rb.family) return ra.family < rb.family ? -1 : 1;
  if (ra.version[0] !== rb.version[0]) return rb.version[0] - ra.version[0];
  if (ra.version[1] !== rb.version[1]) return rb.version[1] - ra.version[1];
  if (ra.tier !== rb.tier) return rb.tier - ra.tier;
  const priceA = a.outputPrice ?? null;
  const priceB = b.outputPrice ?? null;
  if (priceA !== null && priceB !== null && priceA !== priceB) return priceB - priceA;
  if (ra.size !== rb.size) return rb.size - ra.size;
  if (ra.date !== rb.date) return rb.date - ra.date;
  return a.name.localeCompare(b.name, "en") || a.modelId.localeCompare(b.modelId, "en");
}

/**
 * The models of one provider in the order of a list.
 *
 * First the ones an owner put somewhere. Then, of each line, the newest
 * model of each class, the highest class first: "Fable 5.2, Opus 5.5, Sonnet
 * 5.5, Haiku 5.5". Then the models those took the place of, the newest first
 * and the oldest last: "Fable 5.1, Opus 5, Sonnet 5, Opus 4.8, …". So a list
 * starts with what one would choose today, and ends with what is kept for
 * work that still names it.
 */
export function sortModels<T extends RankedModel>(models: readonly T[]): T[] {
  const placed = models.filter((m) => (m.position ?? null) !== null).sort(compareModels);
  const rest = models.filter((m) => (m.position ?? null) === null);
  const ranks = new Map<T, ModelRank>(rest.map((m) => [m, rankOf(m.modelId)] as const));
  // The highest version of each class of each line.
  const newest = new Map<string, [number, number]>();
  const classOf = (rank: ModelRank) => `${rank.family}\u0000${rank.tier}`;
  for (const rank of ranks.values()) {
    const key = classOf(rank);
    const known = newest.get(key);
    if (!known || rank.version[0] > known[0] || (rank.version[0] === known[0] && rank.version[1] > known[1])) newest.set(key, rank.version);
  }
  const isNewest = (m: T) => {
    const rank = ranks.get(m)!;
    const top = newest.get(classOf(rank))!;
    return rank.version[0] === top[0] && rank.version[1] === top[1];
  };
  const current = rest.filter(isNewest).sort((a, b) => {
    const ra = ranks.get(a)!;
    const rb = ranks.get(b)!;
    if (ra.familyOrder !== rb.familyOrder) return ra.familyOrder - rb.familyOrder;
    if (ra.family !== rb.family) return ra.family < rb.family ? -1 : 1;
    if (ra.tier !== rb.tier) return rb.tier - ra.tier;
    return compareModels(a, b);
  });
  const older = rest.filter((m) => !isNewest(m)).sort(compareModels);
  return [...placed, ...current, ...older];
}
