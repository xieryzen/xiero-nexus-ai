import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { loadOperableProject, loadOwnedProject } from "@/lib/project-access";
import { getClientMeta } from "@/lib/request";
import { builtFileResponse, deleteBuilt, getBuilt } from "@/lib/result/built";

export const dynamic = "force-dynamic";

/** A package a build of the project made, as a download. */
export const GET = handle(async (_req, { params }) => {
  const user = requireUser();
  const project = loadOwnedProject(params.id!, user);
  return builtFileResponse(getBuilt(project.id, params.fileId!));
});

/** Remove it. The files it was built from stay. */
export const DELETE = handle(async (req, { params }) => {
  const user = requireUser();
  const { ip, userAgent } = getClientMeta(req);
  const project = loadOperableProject(params.id!, user);
  const file = getBuilt(project.id, params.fileId!);
  deleteBuilt(project.id, file.id);
  audit({ actorUserId: user.id, action: "project.built.delete", targetType: "project", targetId: project.id, metadata: { path: file.path }, ip, userAgent });
  return json({ ok: true });
});
