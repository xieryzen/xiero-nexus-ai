/**
 * The models an account is offered in a conversation, as a list in
 * categories. Pure: used by the server, and tested alone.
 *
 * - The categories are the providers of the installation, in their order
 *   (the priority an owner gave them, then by name).
 * - In a category, the newest model of each class first, the highest class
 *   first, then the older ones, the oldest last (model-rank.ts).
 * - An admin and an owner are offered every model that can be used. A user
 *   is offered what the app itself would work with for them: the models
 *   marked "for users" when any is marked, every model otherwise.
 * - A model has a lowest role (free, pro, plus, ultra, admin, owner). An
 *   account below it is shown the model with the role it takes, and cannot
 *   choose it: that is the hierarchy of the plans, made visible.
 */
import { sortModels } from "./model-rank";
import { isAdminRole, isTier, tierLabel, tierRank, type Tier } from "./roles";

export interface OfferedModel {
  id: string;
  /** The id the provider knows it by. */
  modelId: string;
  /** What it is called. */
  name: string;
  providerId: string;
  providerName: string;
  /** Where its provider stands among the providers: the lowest first. */
  providerPriority: number;
  /** Marked for the work of users. */
  forUsers: boolean;
  /** The lowest role that may choose it. */
  minTier: string;
  /** Where an owner put it among the models of its provider. */
  position: number | null;
  /** What a million tokens of output cost, where that is known. */
  outputPrice: number | null;
  /** Whether it is known to work with tools: act, not only answer. */
  tools: boolean;
}

export interface PickerModel {
  id: string;
  name: string;
  /** The lowest role that may choose it. */
  minTier: Tier;
  /** The account's role is below it. */
  locked: boolean;
  tools: boolean;
}

export interface PickerGroup {
  /** The provider's id. */
  id: string;
  /** The category: what the provider is called. */
  name: string;
  models: PickerModel[];
}

export function pickerGroups(models: readonly OfferedModel[], account: { role: string; tier: Tier }): PickerGroup[] {
  const marked = models.filter((m) => m.forUsers);
  const pool = isAdminRole(account.role) || marked.length === 0 ? models : marked;
  const byProvider = new Map<string, OfferedModel[]>();
  for (const model of pool) {
    const list = byProvider.get(model.providerId) ?? [];
    list.push(model);
    byProvider.set(model.providerId, list);
  }
  const mine = tierRank(account.tier);
  return [...byProvider.values()]
    .sort((a, b) => a[0]!.providerPriority - b[0]!.providerPriority || a[0]!.providerName.localeCompare(b[0]!.providerName, "en") || a[0]!.providerId.localeCompare(b[0]!.providerId))
    .map((list) => ({
      id: list[0]!.providerId,
      name: list[0]!.providerName,
      models: sortModels(list).map((m) => {
          const minTier: Tier = isTier(m.minTier) ? m.minTier : "free";
          return { id: m.id, name: m.name, minTier, locked: mine < tierRank(minTier), tools: m.tools };
        }),
    }));
}

/** The model of that id among what is offered, with its category. */
export function offeredModel(groups: readonly PickerGroup[], id: string): (PickerModel & { category: string }) | undefined {
  for (const group of groups) {
    const model = group.models.find((m) => m.id === id);
    if (model) return { ...model, category: group.name };
  }
  return undefined;
}

/** What is said to an account that names a model above its role. */
export function modelAboveRole(model: { name: string; minTier: Tier }, tier: Tier): string {
  const from = model.minTier === "owner" ? "for an owner" : model.minTier === "admin" ? "for an admin and an owner" : `part of the ${tierLabel(model.minTier)} plan${model.minTier === "ultra" ? "" : " and the plans above it"}`;
  const own = tier === "admin" ? "Your role is Admin" : `Your plan is ${tierLabel(tier)}`;
  return `"${model.name}" is ${from}. ${own}. Choose another model, or leave the choice to the app.`;
}
