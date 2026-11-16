/**
 * How an agent is told about its skills. Pure.
 *
 * A skill is given in full while there is room, since a model that has the
 * words in front of it follows them better than one that has to ask for them.
 * What does not fit is named with its description, and read with the
 * read_skill tool. The same goes for the files of a skill: they are listed,
 * and read when the instructions point to one.
 */

export interface PromptSkill {
  name: string;
  description: string;
  instructions: string;
  files: { path: string; sizeBytes: number }[];
}

/** Most characters of one skill's instructions in a prompt. */
export const SKILL_PROMPT_CHARS = 16_000;
/** Most characters of all skills' instructions in a prompt. */
export const SKILLS_PROMPT_TOTAL_CHARS = 40_000;
/** Most skills an agent is told about for one task. */
export const SKILLS_PER_TASK_MAX = 12;
/** Most files of one skill that are listed by name. */
const FILES_LISTED_MAX = 40;

export interface SkillsBlockOptions {
  /** Whether the agent has the read_skill tool for this task. */
  canRead: boolean;
  perSkillChars?: number;
  totalChars?: number;
}

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

/** Cut at the end of a line where there is one near, so that no sentence is left half. */
function head(text: string, max: number): string {
  if (text.length <= max) return text;
  const piece = text.slice(0, max);
  const lineEnd = piece.lastIndexOf("\n");
  return (lineEnd > max * 0.6 ? piece.slice(0, lineEnd) : piece).trimEnd();
}

/**
 * The part of a system prompt that gives an agent its skills, or "" when it
 * has none. It starts with two line breaks, to be put after what is there.
 */
export function skillsBlock(skills: PromptSkill[], options: SkillsBlockOptions): string {
  const list = skills.slice(0, SKILLS_PER_TASK_MAX);
  if (list.length === 0) return "";
  const perSkill = options.perSkillChars ?? SKILL_PROMPT_CHARS;
  let room = options.totalChars ?? SKILLS_PROMPT_TOTAL_CHARS;
  const parts: string[] = [
    list.length === 1
      ? "You have a skill for this work: a way of doing it that your organisation wrote down."
      : `You have ${list.length} skills for this work: ways of doing it that your organisation wrote down.`,
    "A skill is part of your instructions. Follow it where it applies to the task; where you leave it, say that you did and why.",
  ];
  for (const skill of list) {
    const lines = [`### Skill: ${skill.name}`];
    if (skill.description) lines.push(skill.description);
    const instructions = skill.instructions.trim();
    const allowed = Math.min(perSkill, room);
    if (!instructions) {
      // A skill of a description only: there is nothing more to read.
    } else if (allowed >= Math.min(instructions.length, 400)) {
      const shown = head(instructions, allowed);
      room -= shown.length;
      lines.push("", shown);
      if (shown.length < instructions.length) {
        lines.push(
          "",
          options.canRead
            ? `(The rest of this skill is not shown here: ${instructions.length - shown.length} more characters. Read all of it with read_skill before you rely on a part you have not seen.)`
            : "(This skill is shortened here.)",
        );
      }
    } else {
      lines.push(
        "",
        options.canRead
          ? "(Not shown here. Read it with read_skill when the task calls for it.)"
          : "(Its instructions do not fit here; work from its description.)",
      );
    }
    if (skill.files.length > 0 && options.canRead) {
      const named = skill.files.slice(0, FILES_LISTED_MAX).map((f) => `${f.path} (${size(f.sizeBytes)})`);
      const more = skill.files.length - named.length;
      lines.push(
        "",
        `Files of this skill: ${named.join(", ")}${more > 0 ? `, and ${more} more` : ""}. Read one with read_skill when the instructions point to it.`,
      );
    }
    parts.push(lines.join("\n"));
  }
  const untold = skills.length - list.length;
  if (untold > 0) parts.push(`(${untold} more skill${untold === 1 ? " is" : "s are"} not shown: an agent is told about ${SKILLS_PER_TASK_MAX} at most.)`);
  return `\n\n${parts.join("\n\n")}`;
}

/** The names of an agent's skills in a few words, for the one who plans the work. */
export function skillNames(skills: { name: string }[], max = 6): string {
  if (skills.length === 0) return "";
  const names = skills.slice(0, max).map((s) => s.name);
  return names.join(", ") + (skills.length > names.length ? `, +${skills.length - names.length}` : "");
}
