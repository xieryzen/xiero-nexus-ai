import { handle, json, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getClientMeta } from "@/lib/request";
import { loadOwnedProject } from "@/lib/project-access";
import { deleteRemote, getRemote, serializeRemote, setRemote } from "@/lib/git";
import { gitRemoteSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req, { params }) => {
  const user = requireUser();
  const project = loadOwnedProject(params.id!, user);
  const remote = getRemote(project.id);
  return json({ remote: remote ? serializeRemote(remote) : null });
});

export const PUT = handle(async (req, { params }) => {
  const user = requireUser();
  const { ip, userAgent } = getClientMeta(req);
  const project = loadOwnedProject(params.id!, user);
  const body = await parseBody(req, gitRemoteSchema);
  const remote = setRemote(project.id, body, user.id);
  audit({ actorUserId: user.id, action: "git.configure", targetType: "project", targetId: project.id, metadata: { host: remote.host, owner: remote.owner, repo: remote.repo }, ip, userAgent });
  return json({ remote: serializeRemote(remote) });
});

export const DELETE = handle(async (_req, { params }) => {
  const user = requireUser();
  const project = loadOwnedProject(params.id!, user);
  deleteRemote(project.id);
  return json({ ok: true });
});
