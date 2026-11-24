import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { chatPicker } from "@/lib/chat-models";
import { tierOf } from "@/lib/roles";

export const dynamic = "force-dynamic";

/**
 * GET /api/chat/models
 *
 * The models this account is offered in a conversation, as the composer
 * shows them: in categories (the providers, in their order), in each the
 * highest and newest first. A model above the account's role is listed with
 * `locked` and the role it takes (`minTier`). Sending none of them leaves
 * the choice to the app.
 */
export const GET = handle(async () => {
  const user = requireUser();
  return json({ tier: tierOf(user), groups: chatPicker(user) });
});
