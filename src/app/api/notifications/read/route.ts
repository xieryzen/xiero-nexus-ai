import { handle, json, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { markRead, unreadCount } from "@/lib/notifications";
import { notificationsReadSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Mark one notification as read ({ id }), or all of them ({}). */
export const POST = handle(async (req) => {
  const user = requireUser();
  const body = await parseBody(req, notificationsReadSchema);
  markRead(user.id, body.id);
  return json({ unread: unreadCount(user.id) });
});
