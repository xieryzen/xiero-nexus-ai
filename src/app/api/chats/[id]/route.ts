import { handle, json, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { deleteChat, loadChat, messagesOf, pinChat, renameChat } from "@/lib/chat/store";
import { isAnswering } from "@/lib/chat/turn";
import { AppError } from "@/lib/errors";
import { chatRenameSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** A conversation of the account that asks, with what was said. 404 for anyone else's. */
export const GET = handle(async (_req, { params }) => {
  const user = requireUser();
  const chat = loadChat(user.id, params.id!);
  return json({
    chat: { id: chat.id, title: chat.title, systemPrompt: chat.systemPrompt, pinned: chat.pinnedAt !== null, createdAt: chat.createdAt.getTime(), updatedAt: chat.updatedAt.getTime() },
    messages: messagesOf(chat.id),
    answering: isAnswering(chat.id),
  });
});

export const PATCH = handle(async (req, { params }) => {
  const user = requireUser();
  const body = await parseBody(req, chatRenameSchema);
  let chat = loadChat(user.id, params.id!);
  if (body.title !== undefined) chat = renameChat(user.id, chat.id, body.title);
  if (body.pinned !== undefined) chat = pinChat(user.id, chat.id, body.pinned);
  return json({ chat: { id: chat.id, title: chat.title, pinned: chat.pinnedAt !== null } });
});

export const DELETE = handle(async (_req, { params }) => {
  const user = requireUser();
  const chat = loadChat(user.id, params.id!);
  if (isAnswering(chat.id)) throw new AppError(409, "chat_busy", "This conversation is still being answered. Stop it first.");
  deleteChat(user.id, chat.id);
  return json({ ok: true });
});
