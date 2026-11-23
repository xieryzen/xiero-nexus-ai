import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { deleteAllChats, listChats } from "@/lib/chat/store";
import { getClientMeta } from "@/lib/request";

export const dynamic = "force-dynamic";

/** The conversations of the account that asks, the ones written in last first. Nobody else's. */
export const GET = handle(async () => {
  const user = requireUser();
  return json({ chats: listChats(user.id) });
});

/** Delete all of them. What was remembered from them stays (Memory page). */
export const DELETE = handle(async (req) => {
  const user = requireUser();
  const { ip, userAgent } = getClientMeta(req);
  const removed = deleteAllChats(user.id);
  audit({ actorUserId: user.id, action: "chat.clear", targetType: "user", targetId: user.id, metadata: { removed }, ip, userAgent });
  return json({ removed });
});
