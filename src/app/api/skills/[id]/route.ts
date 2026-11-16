import { handle, json, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getClientMeta } from "@/lib/request";
import { deleteSkill, describeSkill, loadSkill, updateSkill } from "@/lib/skills/service";
import { skillUpdateSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req, { params }) => {
  requireAdmin(); // how the installation is set up is shown to administrators (roles.ts: seesSetup)
  return json({ skill: describeSkill(loadSkill(params.id!)) });
});

export const PATCH = handle(async (req, { params }) => {
  const user = requireAdmin();
  const { ip, userAgent } = getClientMeta(req);
  const body = await parseBody(req, skillUpdateSchema);
  const skill = updateSkill(params.id!, body);
  audit({
    actorUserId: user.id,
    action: "skill.update",
    targetType: "skill",
    targetId: skill.id,
    metadata: { name: skill.name, ...(body.enabled !== undefined ? { enabled: body.enabled } : {}) },
    ip,
    userAgent,
  });
  return json({ skill: describeSkill(skill) });
});

export const DELETE = handle(async (req, { params }) => {
  const user = requireAdmin();
  const { ip, userAgent } = getClientMeta(req);
  const skill = deleteSkill(params.id!);
  audit({ actorUserId: user.id, action: "skill.delete", targetType: "skill", targetId: skill.id, metadata: { name: skill.name }, ip, userAgent });
  return json({ ok: true });
});
