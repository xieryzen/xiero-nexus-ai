import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { loadChat } from "@/lib/chat/store";
import { stopAnswer } from "@/lib/chat/turn";

export const dynamic = "force-dynamic";

/**
 * Stop the answer a conversation of the account that asks is being given.
 * What was done until then stays in the conversation, and what a tool is
 * doing is ended: a command on a server is killed, a page in the browser is
 * closed. `stopping` is false when nothing was being answered.
 */
export const POST = handle(async (_req, { params }) => {
  const user = requireUser();
  const chat = loadChat(user.id, params.id!);
  return json({ stopping: stopAnswer(chat.id) });
});
