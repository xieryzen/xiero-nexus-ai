import "server-only";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { agentSkills, skillFiles, skills, teamSkills, type Skill } from "@/db/schema";
import { Errors } from "../errors";
import {
  SKILL_DESCRIPTION_MAX,
  SKILL_FILES_MAX,
  SKILL_FILES_TOTAL_MAX,
  SKILL_FILE_MAX_BYTES,
  SKILL_INSTRUCTIONS_MAX,
  SKILL_NAME_MAX,
  type ParsedSkill,
  type ParsedSkillFile,
} from "./parse";
import { SKILLS_PER_OWNER_MAX } from "./limits";
import { SKILLS_PER_TASK_MAX, type PromptSkill } from "./prompt";
import { safeArchivePath } from "./zip";

/**
 * Skills in the database: what is kept of a SKILL.md, which agents and teams
 * have it, and what an agent is given when it starts on a task.
 */

export function skillKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function parseMetadata(raw: string): Record<string, string> {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: Record<string, string> = {};
    for (const [key, v] of Object.entries(value)) if (typeof v === "string") out[key] = v;
    return out;
  } catch {
    return {};
  }
}

export interface SkillFileInfo {
  path: string;
  sizeBytes: number;
}

function filesOf(ids: string[]): Map<string, SkillFileInfo[]> {
  const map = new Map<string, SkillFileInfo[]>();
  if (ids.length === 0) return map;
  for (const row of db
    .select({ skillId: skillFiles.skillId, path: skillFiles.path, sizeBytes: skillFiles.sizeBytes })
    .from(skillFiles)
    .where(inArray(skillFiles.skillId, ids))
    .orderBy(asc(skillFiles.path))
    .all()) {
    const list = map.get(row.skillId) ?? [];
    list.push({ path: row.path, sizeBytes: row.sizeBytes });
    map.set(row.skillId, list);
  }
  return map;
}

function owners(table: typeof agentSkills | typeof teamSkills): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const rows =
    table === agentSkills
      ? db.select({ skillId: agentSkills.skillId, ownerId: agentSkills.agentId }).from(agentSkills).all()
      : db.select({ skillId: teamSkills.skillId, ownerId: teamSkills.teamId }).from(teamSkills).all();
  for (const row of rows) {
    const list = map.get(row.skillId) ?? [];
    list.push(row.ownerId);
    map.set(row.skillId, list);
  }
  return map;
}

export function serializeSkill(
  row: Skill,
  extras: { files?: SkillFileInfo[]; agentIds?: string[]; teamIds?: string[]; withInstructions?: boolean } = {},
) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: extras.withInstructions === false ? undefined : row.instructions,
    instructionChars: row.instructions.length,
    metadata: parseMetadata(row.metadata),
    sourceName: row.sourceName,
    enabled: row.enabled,
    files: extras.files ?? [],
    agentIds: extras.agentIds ?? [],
    teamIds: extras.teamIds ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export type SkillDTO = ReturnType<typeof serializeSkill>;

export function listSkills(opts: { withInstructions?: boolean } = {}): SkillDTO[] {
  const rows = db.select().from(skills).orderBy(asc(skills.nameKey)).all();
  const files = filesOf(rows.map((r) => r.id));
  const byAgent = owners(agentSkills);
  const byTeam = owners(teamSkills);
  return rows.map((row) =>
    serializeSkill(row, {
      files: files.get(row.id),
      agentIds: byAgent.get(row.id),
      teamIds: byTeam.get(row.id),
      withInstructions: opts.withInstructions,
    }),
  );
}

export function loadSkill(id: string): Skill {
  const row = db.select().from(skills).where(eq(skills.id, id)).get();
  if (!row) throw Errors.notFound("Skill not found");
  return row;
}

export function describeSkill(row: Skill): SkillDTO {
  return serializeSkill(row, {
    files: filesOf([row.id]).get(row.id),
    agentIds: db.select({ id: agentSkills.agentId }).from(agentSkills).where(eq(agentSkills.skillId, row.id)).all().map((r) => r.id),
    teamIds: db.select({ id: teamSkills.teamId }).from(teamSkills).where(eq(teamSkills.skillId, row.id)).all().map((r) => r.id),
  });
}

// ─── Writing ─────────────────────────────────────────────────────────────────

function cleanFiles(files: ParsedSkillFile[]): ParsedSkillFile[] {
  const out: ParsedSkillFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    const path = safeArchivePath(file.path);
    if (!path) throw Errors.badRequest(`"${file.path.slice(0, 80)}" is not a path a skill's file can have.`);
    if (/(^|\/)skill\.md$/i.test(path) && !path.includes("/")) {
      throw Errors.badRequest("SKILL.md is the skill's instructions, not one of its files.");
    }
    if (seen.has(path)) throw Errors.badRequest(`The skill has the file "${path}" twice.`);
    const size = Buffer.byteLength(file.content, "utf8");
    if (size > SKILL_FILE_MAX_BYTES) {
      throw Errors.badRequest(`"${path}" is larger than ${Math.floor(SKILL_FILE_MAX_BYTES / 1024)} KB.`);
    }
    total += size;
    seen.add(path);
    out.push({ path, content: file.content });
  }
  if (out.length > SKILL_FILES_MAX) throw Errors.badRequest(`A skill keeps at most ${SKILL_FILES_MAX} files.`);
  if (total > SKILL_FILES_TOTAL_MAX) {
    throw Errors.badRequest(`The files of a skill may be ${Math.floor(SKILL_FILES_TOTAL_MAX / (1024 * 1024))} MB together.`);
  }
  return out;
}

function checkText(input: { name?: string; description?: string; instructions?: string }): void {
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw Errors.badRequest("A skill needs a name.");
    if (name.length > SKILL_NAME_MAX) throw Errors.badRequest(`A skill's name can be ${SKILL_NAME_MAX} characters.`);
  }
  if (input.description !== undefined && input.description.length > SKILL_DESCRIPTION_MAX) {
    throw Errors.badRequest(`A skill's description can be ${SKILL_DESCRIPTION_MAX} characters.`);
  }
  if (input.instructions !== undefined && input.instructions.length > SKILL_INSTRUCTIONS_MAX) {
    throw Errors.badRequest(
      `A skill's instructions can be ${SKILL_INSTRUCTIONS_MAX.toLocaleString("en-US")} characters. Move the long parts into files of the skill.`,
    );
  }
}

function nameTaken(name: string, exceptId?: string): Skill | undefined {
  const key = skillKey(name);
  return db
    .select()
    .from(skills)
    .where(exceptId ? and(eq(skills.nameKey, key), ne(skills.id, exceptId)) : eq(skills.nameKey, key))
    .get();
}

export interface SaveOptions {
  userId: string | null;
  sourceName?: string | null;
  /** What to do when a skill of this name exists. */
  onConflict: "error" | "replace";
}

/**
 * Keep a skill. With "replace", a skill of the same name gets the new text
 * and files and stays with the agents and teams that have it.
 */
export function saveSkill(input: ParsedSkill, opts: SaveOptions): { skill: Skill; replaced: boolean } {
  const name = input.name.trim().replace(/\s+/g, " ");
  checkText({ name, description: input.description, instructions: input.instructions });
  const files = cleanFiles(input.files);
  const existing = nameTaken(name);
  if (existing && opts.onConflict === "error") {
    throw Errors.conflict(`There is a skill named "${existing.name}" already. Replace it, or give this one another name.`);
  }
  const values = {
    name,
    nameKey: skillKey(name),
    description: input.description.trim(),
    instructions: input.instructions,
    metadata: JSON.stringify(input.metadata ?? {}),
    sourceName: opts.sourceName?.slice(0, 200) ?? null,
    updatedAt: new Date(),
  };
  const skill = db.transaction((tx) => {
    let row: Skill;
    if (existing) {
      tx.update(skills).set(values).where(eq(skills.id, existing.id)).run();
      tx.delete(skillFiles).where(eq(skillFiles.skillId, existing.id)).run();
      row = tx.select().from(skills).where(eq(skills.id, existing.id)).get()!;
    } else {
      row = tx.insert(skills).values({ ...values, createdBy: opts.userId }).returning().get();
    }
    for (const file of files) {
      tx.insert(skillFiles)
        .values({ skillId: row.id, path: file.path, content: file.content, sizeBytes: Buffer.byteLength(file.content, "utf8") })
        .run();
    }
    return row;
  });
  return { skill, replaced: Boolean(existing) };
}

export interface SkillPatch {
  name?: string;
  description?: string;
  instructions?: string;
  enabled?: boolean;
  /** When given: the skill's files become these and no others. */
  files?: ParsedSkillFile[];
}

export function updateSkill(id: string, patch: SkillPatch): Skill {
  const existing = loadSkill(id);
  checkText(patch);
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) {
    const name = patch.name.trim().replace(/\s+/g, " ");
    const other = nameTaken(name, existing.id);
    if (other) throw Errors.conflict(`There is a skill named "${other.name}" already.`);
    set.name = name;
    set.nameKey = skillKey(name);
  }
  if (patch.description !== undefined) set.description = patch.description.trim();
  if (patch.instructions !== undefined) set.instructions = patch.instructions;
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  const files = patch.files ? cleanFiles(patch.files) : null;
  db.transaction((tx) => {
    tx.update(skills).set(set).where(eq(skills.id, existing.id)).run();
    if (files) {
      tx.delete(skillFiles).where(eq(skillFiles.skillId, existing.id)).run();
      for (const file of files) {
        tx.insert(skillFiles)
          .values({ skillId: existing.id, path: file.path, content: file.content, sizeBytes: Buffer.byteLength(file.content, "utf8") })
          .run();
      }
    }
  });
  return loadSkill(existing.id);
}

export function deleteSkill(id: string): Skill {
  const existing = loadSkill(id);
  db.delete(skills).where(eq(skills.id, existing.id)).run();
  return existing;
}

/** A file of a skill, or null when it has none of that path. */
export function readSkillFile(skillId: string, path: string): string | null {
  const row = db
    .select({ content: skillFiles.content })
    .from(skillFiles)
    .where(and(eq(skillFiles.skillId, skillId), eq(skillFiles.path, path)))
    .get();
  return row ? row.content : null;
}

export function skillFilesWithContent(skillId: string): ParsedSkillFile[] {
  return db
    .select({ path: skillFiles.path, content: skillFiles.content })
    .from(skillFiles)
    .where(eq(skillFiles.skillId, skillId))
    .orderBy(asc(skillFiles.path))
    .all();
}

// ─── Who has which skill ─────────────────────────────────────────────────────

function existingIds(ids: string[]): string[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  if (unique.length > SKILLS_PER_OWNER_MAX) {
    throw Errors.badRequest(`At most ${SKILLS_PER_OWNER_MAX} skills can be given at once.`);
  }
  const found = new Set(db.select({ id: skills.id }).from(skills).where(inArray(skills.id, unique)).all().map((r) => r.id));
  if (unique.some((id) => !found.has(id))) throw Errors.badRequest("One of the selected skills does not exist.");
  return unique;
}

/** Give an agent these skills and no others. */
export function setAgentSkills(agentId: string, skillIds: string[]): void {
  const ids = existingIds(skillIds);
  db.transaction((tx) => {
    tx.delete(agentSkills).where(eq(agentSkills.agentId, agentId)).run();
    for (const skillId of ids) tx.insert(agentSkills).values({ agentId, skillId }).run();
  });
}

/** Give a team these skills and no others. */
export function setTeamSkills(teamId: string, skillIds: string[]): void {
  const ids = existingIds(skillIds);
  db.transaction((tx) => {
    tx.delete(teamSkills).where(eq(teamSkills.teamId, teamId)).run();
    for (const skillId of ids) tx.insert(teamSkills).values({ teamId, skillId }).run();
  });
}

export function skillIdsForAgent(agentId: string): string[] {
  return db.select({ id: agentSkills.skillId }).from(agentSkills).where(eq(agentSkills.agentId, agentId)).all().map((r) => r.id);
}

export function skillIdsForTeam(teamId: string): string[] {
  return db.select({ id: teamSkills.skillId }).from(teamSkills).where(eq(teamSkills.teamId, teamId)).all().map((r) => r.id);
}

export function agentSkillMap(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of db.select().from(agentSkills).all()) {
    const list = map.get(row.agentId) ?? [];
    list.push(row.skillId);
    map.set(row.agentId, list);
  }
  return map;
}

export function teamSkillMap(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of db.select().from(teamSkills).all()) {
    const list = map.get(row.teamId) ?? [];
    list.push(row.skillId);
    map.set(row.teamId, list);
  }
  return map;
}

// ─── At work ─────────────────────────────────────────────────────────────────

export interface WorkSkill extends PromptSkill {
  id: string;
}

/**
 * The skills an agent has for a task of a project: its own first, then those
 * of the project's team, each once, and only the ones that are switched on.
 */
export function skillsForWork(agentId: string | null | undefined, teamId: string | null | undefined): WorkSkill[] {
  const ids: string[] = [];
  if (agentId) ids.push(...skillIdsForAgent(agentId));
  if (teamId) ids.push(...skillIdsForTeam(teamId));
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = new Map(
    db
      .select()
      .from(skills)
      .where(and(inArray(skills.id, unique), eq(skills.enabled, true)))
      .all()
      .map((row) => [row.id, row] as const),
  );
  const ordered = unique.map((id) => rows.get(id)).filter((row): row is Skill => Boolean(row));
  // By name within each group, so that the same agent is told the same thing each time.
  const own = new Set(agentId ? skillIdsForAgent(agentId) : []);
  ordered.sort((a, b) => Number(own.has(b.id)) - Number(own.has(a.id)) || a.nameKey.localeCompare(b.nameKey));
  const chosen = ordered.slice(0, SKILLS_PER_TASK_MAX);
  const files = filesOf(chosen.map((row) => row.id));
  return chosen.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    files: files.get(row.id) ?? [],
  }));
}
