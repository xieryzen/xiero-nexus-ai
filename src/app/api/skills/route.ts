import { handle, json, parseBody } from "@/lib/api";
import { requireAdmin, requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getClientMeta } from "@/lib/request";
import { describeSkill, listSkills, saveSkill } from "@/lib/skills/service";
import { skillCreateSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** The skills: every signed-in user sees which there are; their text is read one by one. */
export const GET = handle(async () => {
  requireUser();
  return json({ skills: listSkills({ withInstructions: false }) });
});

/** Write a skill down by hand (or by program): name, description, instructions, files. */
export const POST = handle(async (req) => {
  const user = requireAdmin();
  const { ip, userAgent } = getClientMeta(req);
  const body = await parseBody(req, skillCreateSchema);
  const { skill, replaced } = saveSkill(
    {
      name: body.name,
      description: body.description ?? "",
      instructions: body.instructions ?? "",
      metadata: {},
      files: body.files ?? [],
    },
    { userId: user.id, onConflict: body.onConflict ?? "error" },
  );
  audit({
    actorUserId: user.id,
    action: replaced ? "skill.replace" : "skill.create",
    targetType: "skill",
    targetId: skill.id,
    metadata: { name: skill.name, files: body.files?.length ?? 0 },
    ip,
    userAgent,
  });
  return json({ skill: describeSkill(skill), replaced }, { status: replaced ? 200 : 201 });
});
