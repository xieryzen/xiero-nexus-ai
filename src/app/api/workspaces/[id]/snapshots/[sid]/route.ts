import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getClientMeta } from "@/lib/request";
import { getSnapshot, loadOwnedWorkspace, restoreSnapshot } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req, { params }) => {
  const user = requireUser();
  const ws = loadOwnedWorkspace(params.id!, user);
  return json({ snapshot: getSnapshot(ws.id, params.sid!) });
});

/** POST = restore this snapshot over the current workspace files. */
export const POST = handle(async (req, { params }) => {
  const user = requireUser();
  const { ip, userAgent } = getClientMeta(req);
  const ws = loadOwnedWorkspace(params.id!, user);
  const restored = restoreSnapshot(ws.id, params.sid!);
  audit({ actorUserId: user.id, action: "workspace.restore", targetType: "workspace", targetId: ws.id, metadata: { snapshotId: params.sid, restored }, ip, userAgent });
  return json({ ok: true, restored });
});
