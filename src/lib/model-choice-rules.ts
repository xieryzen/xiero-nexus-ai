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
