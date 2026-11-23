/**
 * Which model the app works with when nobody chose one. Pure: used by the
 * server, and tested alone.
 *
 * A user chooses no model (roles.ts: seesSetup). Where they would have chosen
 * one, the app does: for a chat, for the manager of a project, for an image,
 * a video, a voice-over, and for the knowledge base. An administrator marks
 * the models that are for that ("for users", on the Models page).
 *
 * - When models of a kind are marked, only they are used for it: an
 *   administrator who marked the free ones is not billed for another.
 * - When none is marked, every model of the kind can be used.
 * - Among those: one whose last check passed before one whose check failed
 *   (it is tried all the same, when it is all there is), then the cheapest,
 *   one without a price last, then by name.
 */
import { MEDIA_CAPABILITY, isMediaOnly } from "./capabilities";

export const CHOICE_KINDS = ["chat", "image", "video", "audio", "embeddings"] as const;
export type ChoiceKind = (typeof CHOICE_KINDS)[number];

/** What each kind is called in a sentence. */
export const CHOICE_LABEL: Record<ChoiceKind, string> = {
  chat: "Chat and projects",
  image: "Images",
  video: "Videos",
  audio: "Voice-overs",
  embeddings: "Knowledge base",
};

export interface ChoiceModel {
  id: string;
  /** What it is called, for the order among equals. */
  name: string;
  capabilities: readonly string[];
  /** Marked for the work of users. */
  forUsers: boolean;
  /** Its last check failed. */
  failing: boolean;
  /** What it costs for this kind of work, where that is known. */
  price: number | null;
}

/** Whether a model with these capabilities does this kind of work. */
export function fitsKind(capabilities: readonly string[], kind: ChoiceKind): boolean {
  if (kind === "chat") return !isMediaOnly(capabilities);
  if (kind === "embeddings") return capabilities.includes("embeddings");
  return capabilities.includes(MEDIA_CAPABILITY[kind]);
}

/**
 * The models the app works with for this kind, the first choice first. The
 * list holds only models that are switched on and can be asked.
 */
export function choicesFor(models: readonly ChoiceModel[], kind: ChoiceKind): string[] {
  const fitting = models.filter((m) => fitsKind(m.capabilities, kind));
  const marked = fitting.filter((m) => m.forUsers);
  const pool = marked.length > 0 ? marked : fitting;
  const price = (m: ChoiceModel) => m.price ?? Number.POSITIVE_INFINITY;
  return pool
    .slice()
    .sort((a, b) => {
      if (a.failing !== b.failing) return a.failing ? 1 : -1;
      if (price(a) !== price(b)) return price(a) < price(b) ? -1 : 1;
      return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    })
    .map((m) => m.id);
}

/** A model's price for a kind of work: per million tokens in and out, per image, per second, per million characters. */
export function priceFor(
  model: {
    inputPricePerMTok: number | null;
    outputPricePerMTok: number | null;
    pricePerImage: number | null;
    pricePerSecond: number | null;
    pricePerMChars: number | null;
  },
  kind: ChoiceKind,
): number | null {
  if (kind === "image") return model.pricePerImage;
  if (kind === "video") return model.pricePerSecond;
  if (kind === "audio") return model.pricePerMChars;
  if (kind === "embeddings") return model.inputPricePerMTok;
  if (model.inputPricePerMTok === null && model.outputPricePerMTok === null) return null;
  return (model.inputPricePerMTok ?? 0) + (model.outputPricePerMTok ?? 0);
}

// ─── Stand-ins ───────────────────────────────────────────────────────────

/** Most models that stand in for the ones a task, or the manager of a run, is set to. */
export const STAND_INS_MAX = 4;

export interface StandInModel extends ChoiceModel {
  providerId: string;
  /** It did not answer a moment ago, and is not chosen meanwhile. */
  resting: boolean;
  /** It is marked as one that takes tools. */
  tools: boolean;
}

/**
 * Whether the app goes on with another model when the ones a task is set to
 * do not answer, from MODEL_STAND_INS: on unless it says "0", "off", "false"
 * or "no".
 */
export function standInsEnabled(setting: string | undefined | null): boolean {
  return !["0", "off", "false", "no"].includes((setting ?? "").trim().toLowerCase());
}

/**
 * The dearest of the models something is set to, as what a stand-in may cost
 * at most. Null: no limit, because one of them has no price to compare with,
 * or nothing is set.
 */
export function priceCeiling(prices: readonly (number | null)[]): number | null {
  if (prices.length === 0 || prices.some((price) => price === null)) return null;
  return Math.max(...(prices as number[]));
}

/**
 * The models that stand in for the ones a piece of chat work is set to, the
 * first to ask first. A run turns to them when its own models do not answer.
 *
 * - As for the app's own choice: when models are marked "for users", only
 *   they stand in; when none is, every chat model can.
 * - Never one that is failing or resting, and never one that costs more than
 *   the dearest model the work was set to (`ceiling`); a model without a
 *   price is taken to cost more, unless there is no ceiling.
 * - For work with tools, a model that takes tools before one that is not
 *   marked so; then the cheapest, then by name.
 * - One of each provider before a second of any: when a provider is down or
 *   limited, its other models are too.
 */
export function standInsFor(
  models: readonly StandInModel[],
  opts: { own: readonly string[]; ceiling: number | null; wantsTools: boolean; max?: number },
): string[] {
  const own = new Set(opts.own);
  const fitting = models.filter((m) => fitsKind(m.capabilities, "chat"));
  const marked = fitting.filter((m) => m.forUsers);
  const price = (m: StandInModel) => m.price ?? Number.POSITIVE_INFINITY;
  const pool = (marked.length > 0 ? marked : fitting)
    .filter((m) => !own.has(m.id) && !m.failing && !m.resting)
    .filter((m) => opts.ceiling === null || (m.price !== null && m.price <= opts.ceiling))
    .sort((a, b) => {
      if (opts.wantsTools && a.tools !== b.tools) return a.tools ? -1 : 1;
      if (price(a) !== price(b)) return price(a) < price(b) ? -1 : 1;
      return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    });
  // One of each provider in turn, in the order of each provider's best model.
  const byProvider = new Map<string, StandInModel[]>();
  for (const m of pool) {
    const list = byProvider.get(m.providerId) ?? [];
    list.push(m);
    byProvider.set(m.providerId, list);
  }
  const max = opts.max ?? STAND_INS_MAX;
  const out: string[] = [];
  for (let round = 0; out.length < max; round++) {
    let took = false;
    for (const list of byProvider.values()) {
      const m = list[round];
      if (!m || out.length >= max) continue;
      out.push(m.id);
      took = true;
    }
    if (!took) break;
  }
  return out;
}

/**
 * The order in which a piece of chat work asks its models: the ones it is set
 * to that can be used now, then the stand-ins, then the ones it is set to
 * that are failing or resting, which are asked when nothing else answered.
 */
export function askingOrder(own: readonly string[], usable: ReadonlySet<string>, standIns: readonly string[]): string[] {
  const set = [...new Set(own)];
  return [...set.filter((id) => usable.has(id)), ...standIns.filter((id) => !set.includes(id)), ...set.filter((id) => !usable.has(id))];
}
