import { handle, json } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { Errors } from "@/lib/errors";
import { loadSkill, readSkillFile } from "@/lib/skills/service";

export const dynamic = "force-dynamic";

/** One file of a skill: `?path=references/guide.md`. */
export const GET = handle(async (req, { params }) => {
  requireAdmin(); // how the installation is set up is shown to administrators (roles.ts: seesSetup)
  const skill = loadSkill(params.id!);
  const path = new URL(req.url).searchParams.get("path") ?? "";
  const content = path ? readSkillFile(skill.id, path) : null;
  if (content === null) throw Errors.notFound("The skill has no such file");
  return json({ path, content });
});
