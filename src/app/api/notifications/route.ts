import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { clearNotifications, listNotifications, unreadCount } from "@/lib/notifications";

export const dynamic = "force-dynamic";

/** The user's notifications, newest first, and how many are unread. */
export const GET = handle(async () => {
  const user = requireUser();
  return json({ notifications: listNotifications(user.id, 40), unread: unreadCount(user.id) });
});

export const DELETE = handle(async () => {
  const user = requireUser();
  clearNotifications(user.id);
  return json({ ok: true });
});
