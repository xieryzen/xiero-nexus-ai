import { clearAccountNotes, listAccountNotes, rememberForAccount } from "@/lib/account-memory";
import { accessMode, accessOf, handsOver } from "@/lib/access/store";
import { handle, json, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { chatCount } from "@/lib/chat/store";
import { Errors } from "@/lib/errors";
import { getClientMeta } from "@/lib/request";
import { accountNoteSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * What the AI remembers about the account that asks, and what the account
 * handed over to it: notes, and servers, site accounts and keys without
 * what signs in. Nobody else's.
 */
export const GET = handle(async () => {
  const user = requireUser();
  return json({
    notes: listAccountNotes(user.id),
    access: accessOf(user.id),
    handsOver: handsOver(user),
    mode: accessMode(),
    chats: chatCount(user.id),
  });
});

/** Write a note by hand. */
export const POST = handle(async (req) => {
  const user = requireUser();
  const body = await parseBody(req, accountNoteSchema);
  const saved = rememberForAccount(user.id, body.content, { source: "manual" });
  if (!saved) throw Errors.badRequest("The note is empty");
  return json({ note: saved.note, created: saved.created }, { status: saved.created ? 201 : 200 });
});

/** Forget every note. What was handed over stays until it is removed itself. */
export const DELETE = handle(async (req) => {
  const user = requireUser();
  const { ip, userAgent } = getClientMeta(req);
  const removed = clearAccountNotes(user.id);
  audit({ actorUserId: user.id, action: "memory.clear", targetType: "user", targetId: user.id, metadata: { removed }, ip, userAgent });
  return json({ removed });
});
