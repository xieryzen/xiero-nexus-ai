/**
 * How large a skill may be. Pure, and without anything of Node in it: the
 * pages of the browser show these numbers too.
 */

/** The file that is uploaded: a SKILL.md, or an archive of a skill folder. */
export const SKILL_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
export const SKILL_NAME_MAX = 80;
export const SKILL_DESCRIPTION_MAX = 1024;
/** The body of SKILL.md. What is longer belongs in files of the skill. */
export const SKILL_INSTRUCTIONS_MAX = 100_000;
/** One file of a skill. */
export const SKILL_FILE_MAX_BYTES = 256 * 1024;
export const SKILL_FILES_MAX = 60;
export const SKILL_FILES_TOTAL_MAX = 2 * 1024 * 1024;
/** Skills one archive may hold. */
export const SKILLS_PER_UPLOAD_MAX = 30;
/** Skills one agent or one team can be given. */
export const SKILLS_PER_OWNER_MAX = 20;
