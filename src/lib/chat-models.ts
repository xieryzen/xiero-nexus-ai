import "server-only";
import type { User } from "@/db/schema";
import { PlainError } from "./errors";
import { modelAboveRole, offeredModel, pickerGroups, type PickerGroup } from "./chat-model-rules";
import { chatModels } from "./model-options";
import { NOT_IN_PLAN_CODE } from "./plan-rules";
import { isAdminRole, tierOf } from "./roles";

/**
 * The models of a conversation, as the server offers them (the rules are in
 * chat-model-rules.ts): the list the composer shows, and whether a model a
 * request names is one the account may choose.
 */

type Account = Pick<User, "role" | "plan">;

/** The models an account is offered in a conversation, in categories. */
export function chatPicker(account: Account): PickerGroup[] {
  return pickerGroups(
    chatModels().map((m) => ({
      id: m.id,
      modelId: m.modelId,
      name: m.name,
      providerId: m.providerId,
      providerName: m.providerName,
      providerPriority: m.providerPriority,
      forUsers: m.forUsers,
      minTier: m.minTier,
      position: m.position,
      outputPrice: m.outputPricePerMTok,
      // Known to work with tools: its provider can pass them on, and the model is marked for it.
      tools: m.tools && m.capabilities.includes("tool_calling"),
    })),
    { role: account.role, tier: tierOf(account) },
  );
}

/**
 * The model a request names, when the account may choose it. A model above
 * the account's role is refused with which role takes it; one that is not
 * offered at all is said not to be there, to a user, and is left to the
 * check of the request itself for an admin (which says why it cannot be used).
 */
export function namedChatModel(account: Account, modelRowId: string): string {
  const tier = tierOf(account);
  const found = offeredModel(chatPicker(account), modelRowId);
  // Both are said as they are, also to a user: the name is one their own list shows.
  if (found?.locked) throw new PlainError(403, NOT_IN_PLAN_CODE, modelAboveRole(found, tier));
  if (!found && !isAdminRole(account.role)) throw new PlainError(404, "not_found", "That model is not offered. Choose another one, or leave the choice to the app.");
  return modelRowId;
}
