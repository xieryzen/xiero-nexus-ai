import { handle, json } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { AppError, Errors } from "@/lib/errors";
import { readBodyCapped } from "@/lib/media/http";
import { maybeSweep, rateLimit } from "@/lib/ratelimit";
import { getClientMeta } from "@/lib/request";
import { SKILL_UPLOAD_MAX_BYTES } from "@/lib/skills/limits";
import { SkillParseError, parseSkillUpload, type ParsedUpload } from "@/lib/skills/parse";
import { describeSkill, saveSkill, skillKey } from "@/lib/skills/service";
import { db } from "@/db";
import { skills } from "@/db/schema";

export const dynamic = "force-dynamic";

/**
 * Upload a skill: a SKILL.md (or any Markdown or text file), a .skill or .zip
 * of a folder with a SKILL.md in it, or a JSON description. The body is the
 * file itself; its name comes in the `x-file-name` header (URL-encoded).
 *
 * `?onConflict=replace` gives a skill of the same name the new text and
 * files; without it such an upload is refused, and nothing of it is kept.
 */
export const POST = handle(async (req) => {
  const user = requireAdmin();
  const { ip, userAgent } = getClientMeta(req);
  maybeSweep();
  const limit = rateLimit(`skills:upload:${user.id}`, 30, 60_000);
  if (!limit.ok) throw Errors.rateLimited("Too many uploads at once. Wait a minute and try again.");

  let bytes: Buffer;
  try {
    bytes = await readBodyCapped(req, { maxBytes: SKILL_UPLOAD_MAX_BYTES, timeoutMs: 120_000 });
  } catch (err) {
    if (err instanceof AppError && err.code === "upstream_too_large") {
      throw new AppError(413, "too_large", `A skill can be at most ${Math.floor(SKILL_UPLOAD_MAX_BYTES / (1024 * 1024))} MB`);
    }
    throw Errors.badRequest("The upload did not arrive completely. Try again.");
  }
  let name = "";
  try {
    name = decodeURIComponent(req.headers.get("x-file-name") ?? "");
  } catch {
    name = "";
  }
  name = name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200);
  const onConflict = new URL(req.url).searchParams.get("onConflict") === "replace" ? "replace" : "error";

  let parsed: ParsedUpload;
  try {
    parsed = parseSkillUpload(name, bytes);
  } catch (err) {
    if (err instanceof SkillParseError) throw Errors.badRequest(err.message);
    throw err;
  }

  // All of an upload or none of it: names are checked before anything is kept.
  const keys = parsed.skills.map((s) => skillKey(s.name));
  const twice = keys.find((key, index) => keys.indexOf(key) !== index);
  if (twice) throw Errors.badRequest(`The upload has two skills named "${twice}".`);
  if (onConflict === "error") {
    const taken = db.select({ name: skills.name, nameKey: skills.nameKey }).from(skills).all();
    const clash = taken.find((row) => keys.includes(row.nameKey));
    if (clash) {
      throw Errors.conflict(`There is a skill named "${clash.name}" already. Upload again with "replace" to give it the new text.`);
    }
  }

  const saved = db.transaction(() =>
    parsed.skills.map((skill) => saveSkill(skill, { userId: user.id, sourceName: name || null, onConflict })),
  );
  for (const { skill, replaced } of saved) {
    audit({
      actorUserId: user.id,
      action: replaced ? "skill.replace" : "skill.create",
      targetType: "skill",
      targetId: skill.id,
      metadata: { name: skill.name, upload: name || undefined },
      ip,
      userAgent,
    });
  }
  return json(
    {
      skills: saved.map(({ skill, replaced }) => ({ ...describeSkill(skill), replaced })),
      leftOut: parsed.leftOut.slice(0, 100),
    },
    { status: 201 },
  );
});
