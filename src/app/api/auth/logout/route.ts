import { handle, json } from "@/lib/api";
import { getSessionState } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getClientMeta } from "@/lib/request";
import { destroyCurrentSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export const POST = handle(async (req) => {
  const { ip, userAgent } = getClientMeta(req);
  const state = getSessionState();
  destroyCurrentSession();
  if (state.status !== "none") {
    audit({
      actorUserId: state.user.id,
      action: "auth.logout",
      targetType: "user",
      targetId: state.user.id,
      ip,
      userAgent,
    });
  }
  return json({ ok: true });
});
