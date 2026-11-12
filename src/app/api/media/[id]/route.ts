import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { serializeAsset } from "@/lib/media/dto";
import { deleteAsset, loadOwnedAsset } from "@/lib/media/service";
import { getClientMeta } from "@/lib/request";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req, { params }) => {
  const user = requireUser();
  return json({ asset: serializeAsset(loadOwnedAsset(params.id!, user)) });
});

/** Delete the asset and its file. A video still in progress is abandoned. */
export const DELETE = handle(async (req, { params }) => {
  const user = requireUser();
  const { ip, userAgent } = getClientMeta(req);
  const asset = loadOwnedAsset(params.id!, user);
  await deleteAsset(asset);
  audit({
    actorUserId: user.id,
    action: "media.delete",
    targetType: "media",
    targetId: asset.id,
    metadata: { kind: asset.kind, status: asset.status, ownerId: asset.userId },
    ip,
    userAgent,
  });
  return json({ ok: true });
});
