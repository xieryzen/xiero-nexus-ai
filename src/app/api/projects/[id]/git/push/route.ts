import { z } from "zod";
import { handle, json, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getClientMeta } from "@/lib/request";
import { loadOwnedProject } from "@/lib/project-access";
import { pushWorkspace } from "@/lib/git";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const schema = z.object({ message: z.string().trim().max(200).optional() });

export const POST = handle(async (req, { params }) => {
  const user = requireUser();
  const { ip, userAgent } = getClientMeta(req);
  const project = loadOwnedProject(params.id!, user);
  const body = await parseBody(req, schema);
  const result = await pushWorkspace(project.id, body.message ?? "Update from Xiero Nexus AI", user.id);
  audit({ actorUserId: user.id, action: "git.push", targetType: "project", targetId: project.id, metadata: { commitSha: result.commitSha, fileCount: result.fileCount, branch: result.branch }, ip, userAgent });
  return json({ ok: true, ...result });
});
