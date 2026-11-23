import { handle, json, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { deleteChat, loadChat, messagesOf, renameChat } from "@/lib/chat/store";
import { isAnswering } from "@/lib/chat/turn";
import { AppError } from "@/lib/errors";
import { chatRenameSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** A conversation of the account that asks, with what was said. 404 for anyone else's. */
export const GET = handle(async (_req, { params }) => {
  const user = requireUser();
  const chat = loadChat(user.id, params.id!);
  return json({
    chat: { id: chat.id, title: chat.title, systemPrompt: chat.systemPrompt, createdAt: chat.createdAt.getTime(), updatedAt: chat.updatedAt.getTime() },
    messages: messagesOf(chat.id),
    answering: isAnswering(chat.id),
  });
});

export const PATCH = handle(async (req, { params }) => {
  const user = requireUser();
  const body = await parseBody(req, chatRenameSchema);
  const chat = renameChat(user.id, params.id!, body.title);
  return json({ chat: { id: chat.id, title: chat.title } });
});

export const DELETE = handle(async (_req, { params }) => {
  const user = requireUser();
  const chat = loadChat(user.id, params.id!);
  if (isAnswering(chat.id)) throw new AppError(409, "chat_busy", "This conversation is still being answered. Stop it first.");
  deleteChat(user.id, chat.id);
  return json({ ok: true });
});
