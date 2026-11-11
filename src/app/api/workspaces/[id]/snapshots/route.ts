import { z } from "zod";
import { handle, json, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getClientMeta } from "@/lib/request";
import { createSnapshot, listSnapshots, loadOwnedWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";

const schema = z.object({ message: z.string().trim().max(200).optional().default("") });

export const GET = handle(async (_req, { params }) => {
  const user = requireUser();
  const ws = loadOwnedWorkspace(params.id!, user);
  return json({ snapshots: listSnapshots(ws.id) });
});

export const POST = handle(async (req, { params }) => {
  const user = requireUser();
  const { ip, userAgent } = getClientMeta(req);
  const ws = loadOwnedWorkspace(params.id!, user);
  const body = await parseBody(req, schema);
  const snap = createSnapshot(ws.id, body.message ?? "", user.id);
  audit({ actorUserId: user.id, action: "workspace.snapshot", targetType: "workspace", targetId: ws.id, metadata: { fileCount: snap.fileCount }, ip, userAgent });
  return json({ snapshot: { id: snap.id, message: snap.message, fileCount: snap.fileCount, createdAt: snap.createdAt } }, { status: 201 });
});
