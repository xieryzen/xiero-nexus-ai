import { updateOwnAccount, updateOwnAccountSchema } from "@/lib/accounts";
import { handle, json, parseBody } from "@/lib/api";
import { publicUser, requireUser } from "@/lib/auth";
import { getClientMeta } from "@/lib/request";
import { createSession, destroyAllSessions, setSessionCookie } from "@/lib/session";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const user = requireUser();
  return json({ user: publicUser(user) });
});

/**
 * Change one's own username, email or password. The current password is
 * asked for every time. After a new password, every other session is over
 * and this one goes on under a new cookie.
 */
export const PATCH = handle(async (req) => {
  const user = requireUser();
  const meta = getClientMeta(req);
  const body = await parseBody(req, updateOwnAccountSchema);
  const result = updateOwnAccount(user, body, meta);
  if (result.passwordChanged) {
    destroyAllSessions(user.id);
    setSessionCookie(createSession(user.id, meta));
  }
  return json({ user: publicUser(result.user), passwordChanged: result.passwordChanged });
});
