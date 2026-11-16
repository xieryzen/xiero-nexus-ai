import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { skillMarkdown } from "@/lib/skills/parse";
import { describeSkill, loadSkill, skillFilesWithContent } from "@/lib/skills/service";
import { writeZip } from "@/lib/skills/zip";

export const dynamic = "force-dynamic";

/**
 * The skill as a file that can be uploaded again, here or elsewhere: a
 * .skill (a ZIP of a folder with SKILL.md and the skill's files), or with
 * `?format=md` the SKILL.md alone.
 */
export const GET = handle(async (req, { params }) => {
  requireUser();
  const row = loadSkill(params.id!);
  const skill = describeSkill(row);
  const markdown = skillMarkdown({
    name: skill.name,
    description: skill.description,
    instructions: row.instructions,
    metadata: skill.metadata,
  });
  const folder =
    skill.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "skill";
  if (new URL(req.url).searchParams.get("format") === "md") {
    return new Response(markdown, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${folder}.md"`,
        "cache-control": "no-store",
      },
    });
  }
  const archive = writeZip([
    { path: `${folder}/SKILL.md`, data: Buffer.from(markdown, "utf8") },
    ...skillFilesWithContent(row.id).map((file) => ({
      path: `${folder}/${file.path}`,
      data: Buffer.from(file.content, "utf8"),
    })),
  ]);
  return new Response(new Uint8Array(archive), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${folder}.skill"`,
      "content-length": String(archive.length),
      "cache-control": "no-store",
    },
  });
});
