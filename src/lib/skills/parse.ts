import {
  SKILL_DESCRIPTION_MAX,
  SKILL_FILES_MAX,
  SKILL_FILES_TOTAL_MAX,
  SKILL_FILE_MAX_BYTES,
  SKILL_INSTRUCTIONS_MAX,
  SKILL_NAME_MAX,
  SKILL_UPLOAD_MAX_BYTES,
  SKILLS_PER_UPLOAD_MAX,
} from "./limits";
import { ZipError, looksLikeZip, readZip, safeArchivePath } from "./zip";

/**
 * Reading a skill from what a person uploads. Pure.
 *
 * A skill is a SKILL.md: optional front matter (name, description) and the
 * instructions in Markdown. It may come as that one file, or as an archive
 * (.skill or .zip) of a folder with a SKILL.md in it and the files the
 * instructions refer to. One archive may hold several such folders.
 *
 * Only text is kept: an agent reads a skill, it does not run it. Pictures,
 * fonts and other binary files of an archive are left out, and said so.
 */

export {
  SKILL_DESCRIPTION_MAX,
  SKILL_FILES_MAX,
  SKILL_FILES_TOTAL_MAX,
  SKILL_FILE_MAX_BYTES,
  SKILL_INSTRUCTIONS_MAX,
  SKILL_NAME_MAX,
  SKILL_UPLOAD_MAX_BYTES,
  SKILLS_PER_UPLOAD_MAX,
};

const ARCHIVE_LIMITS = {
  maxEntries: 2000,
  maxEntryBytes: SKILL_FILE_MAX_BYTES,
  maxTotalBytes: 64 * 1024 * 1024,
};

export class SkillParseError extends Error {}

export interface ParsedSkillFile {
  path: string;
  content: string;
}

export interface ParsedSkill {
  name: string;
  description: string;
  instructions: string;
  /** Other front matter, such as license or version. */
  metadata: Record<string, string>;
  files: ParsedSkillFile[];
}

export interface ParsedUpload {
  skills: ParsedSkill[];
  /** What was in the upload and is not in the skills, each with the reason. */
  leftOut: string[];
}

// ─── Text ────────────────────────────────────────────────────────────────────

/** The bytes as text, or null when they are not text (not UTF-8, or with a NUL in it). */
export function decodeText(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (text.includes("\u0000")) return null;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n?/g, "\n");
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cut(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

// ─── Front matter ────────────────────────────────────────────────────────────

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v
      .slice(1, -1)
      .replace(/\\(["\\nt])/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

function flowList(value: string): string | null {
  const v = value.trim();
  if (!v.startsWith("[") || !v.endsWith("]")) return null;
  return v
    .slice(1, -1)
    .split(",")
    .map((item) => unquote(item))
    .filter(Boolean)
    .join(", ");
}

/**
 * The front matter of a SKILL.md as a flat list of strings. It reads the YAML
 * that skills are written in: `key: value`, quoted values, values that go on
 * over indented lines, `|` and `>` blocks, lists, and one level of nesting
 * (which becomes `parent.key`). Anything else is kept as the text it is.
 */
export function parseFrontMatter(yaml: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = yaml.split("\n");
  let i = 0;
  const indented = (line: string) => /^\s+\S/.test(line);
  while (i < lines.length) {
    const line = lines[i]!;
    const top = /^([A-Za-z0-9_.-]+)\s*:(?:\s+(.*)|\s*)$/.exec(line);
    if (!top) {
      i++;
      continue;
    }
    const key = top[1]!.toLowerCase();
    const rest = (top[2] ?? "").trim();
    i++;
    // The lines that belong to this key: indented ones, and empty ones between them.
    const block: string[] = [];
    while (i < lines.length && (indented(lines[i]!) || (lines[i]!.trim() === "" && block.length > 0))) {
      block.push(lines[i]!);
      i++;
    }
    while (block.length > 0 && block[block.length - 1]!.trim() === "") block.pop();
    const indent = Math.min(...block.filter((l) => l.trim() !== "").map((l) => /^\s*/.exec(l)![0].length), 1000);
    const body = block.map((l) => (l.trim() === "" ? "" : l.slice(indent)));

    if (/^[|>][+-]?\d*$/.test(rest)) {
      out[key] = rest.startsWith("|")
        ? body.join("\n").trim()
        : body
            .join("\n")
            .split(/\n{2,}/)
            .map((paragraph) => oneLine(paragraph))
            .join("\n")
            .trim();
      continue;
    }
    if (rest !== "") {
      const list = flowList(rest);
      // A plain value may go on over the following indented lines.
      out[key] = list ?? oneLine([unquote(rest), ...body].join(" "));
      continue;
    }
    if (body.length === 0) {
      out[key] = "";
      continue;
    }
    if (body.every((l) => l === "" || /^-\s+/.test(l) || /^\s/.test(l))) {
      out[key] = body
        .filter((l) => /^-\s+/.test(l))
        .map((l) => unquote(l.replace(/^-\s+/, "")))
        .join(", ");
      continue;
    }
    const nested = body.map((l) => /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(l));
    if (nested.every((m, index) => m !== null || body[index] === "")) {
      for (const m of nested) if (m) out[`${key}.${m[1]!.toLowerCase()}`] = flowList(m[2]!) ?? unquote(m[2]!);
      continue;
    }
    out[key] = oneLine(body.join(" "));
  }
  return out;
}

/** A Markdown text as its front matter and what follows it. */
export function splitFrontMatter(text: string): { frontMatter: Record<string, string>; body: string } {
  const match = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(text);
  if (!match) return { frontMatter: {}, body: text };
  return { frontMatter: parseFrontMatter(match[1]!), body: text.slice(match[0].length) };
}

// ─── One skill ───────────────────────────────────────────────────────────────

function nameFromFile(fileName: string): string {
  const base = fileName.replace(/\\/g, "/").split("/").pop() ?? "";
  return base
    .replace(/\.(skill|zip|md|markdown|mdx|txt|json)$/i, "")
    .replace(/[_]+/g, " ")
    .trim();
}

/**
 * A SKILL.md as a skill. The name is the front matter's, else the first
 * heading, else `fallbackName`; the description is the front matter's, else
 * the first paragraph.
 */
export function parseSkillMarkdown(text: string, fallbackName: string): ParsedSkill {
  const { frontMatter, body } = splitFrontMatter(text);
  const instructions = body.trim();
  const heading = /^#{1,3}[ \t]+(.+?)[ \t#]*$/m.exec(instructions)?.[1];
  const name = cut(oneLine(frontMatter.name || heading || fallbackName || ""), SKILL_NAME_MAX);
  if (!name) throw new SkillParseError("The skill has no name: give it one in the front matter (name: ...) or as a heading.");
  if (!instructions && !frontMatter.description) {
    throw new SkillParseError(`The skill "${name}" is empty: a SKILL.md says what to do, in Markdown.`);
  }
  if (instructions.length > SKILL_INSTRUCTIONS_MAX) {
    throw new SkillParseError(
      `The instructions of "${name}" are ${instructions.length.toLocaleString("en-US")} characters; at most ${SKILL_INSTRUCTIONS_MAX.toLocaleString("en-US")} are kept. Move the long parts into files of the skill.`,
    );
  }
  let description = oneLine(frontMatter.description ?? "");
  if (!description) {
    const paragraph = instructions
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .find((p) => p && !p.startsWith("#") && !p.startsWith("```") && !p.startsWith("|"));
    description = oneLine(paragraph ?? "");
    if (description.length > 300) description = cut(description, 300);
  }
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(frontMatter)) {
    if (key === "name" || key === "description" || !value) continue;
    if (Object.keys(metadata).length >= 20) break;
    metadata[key.slice(0, 60)] = cut(value, 500);
  }
  return { name, description: cut(description, SKILL_DESCRIPTION_MAX), instructions, metadata, files: [] };
}

// ─── An archive ──────────────────────────────────────────────────────────────

const JUNK = /(^|\/)(__MACOSX|\.git|\.svn|node_modules|\.idea|\.vscode)(\/|$)|(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i;

function isSkillFile(path: string): boolean {
  return /(^|\/)skill\.md$/i.test(path);
}

function dirOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

function within(path: string, dir: string): boolean {
  return dir === "" || path.startsWith(`${dir}/`);
}

function fromArchive(bytes: Buffer, fileName: string): ParsedUpload {
  let unpacked;
  try {
    unpacked = readZip(bytes, ARCHIVE_LIMITS);
  } catch (err) {
    throw new SkillParseError(err instanceof ZipError ? err.message : "The archive cannot be read.");
  }
  const leftOut = unpacked.leftOut.map((item) => `${item.path}: ${item.reason}`);
  const entries = unpacked.entries.filter((entry) => !JUNK.test(entry.path));

  let roots = entries.filter((entry) => isSkillFile(entry.path));
  if (roots.length === 0) {
    // No SKILL.md: one Markdown file can only be the skill.
    const markdown = entries.filter((entry) => /\.(md|markdown|mdx)$/i.test(entry.path));
    if (markdown.length !== 1) {
      throw new SkillParseError(
        markdown.length === 0
          ? "The archive has no SKILL.md: a skill is a folder with a SKILL.md in it."
          : "The archive has no SKILL.md, and several Markdown files: name the one with the instructions SKILL.md.",
      );
    }
    roots = markdown;
  }
  if (roots.length > SKILLS_PER_UPLOAD_MAX) {
    throw new SkillParseError(`The archive has ${roots.length} skills; at most ${SKILLS_PER_UPLOAD_MAX} are taken at once.`);
  }
  const rootDirs = roots.map((entry) => dirOf(entry.path));
  const skills: ParsedSkill[] = [];
  for (const root of roots) {
    const dir = dirOf(root.path);
    const text = decodeText(root.data);
    if (text === null) throw new SkillParseError(`${root.path} is not text.`);
    const skill = parseSkillMarkdown(text, dir.split("/").pop() || nameFromFile(fileName));
    let total = 0;
    for (const entry of entries) {
      if (entry === root || !within(entry.path, dir)) continue;
      // A file of a skill folder further down belongs to that skill.
      if (rootDirs.some((other) => other !== dir && within(other, dir) && within(entry.path, other))) continue;
      const path = dir === "" ? entry.path : entry.path.slice(dir.length + 1);
      const content = decodeText(entry.data);
      if (content === null) {
        leftOut.push(`${entry.path}: it is not text (a picture, a font, a program), and an agent reads a skill`);
        continue;
      }
      if (skill.files.length >= SKILL_FILES_MAX) {
        leftOut.push(`${entry.path}: a skill keeps at most ${SKILL_FILES_MAX} files`);
        continue;
      }
      if (total + entry.data.length > SKILL_FILES_TOTAL_MAX) {
        leftOut.push(`${entry.path}: the files of a skill may be ${Math.floor(SKILL_FILES_TOTAL_MAX / (1024 * 1024))} MB together`);
        continue;
      }
      total += entry.data.length;
      skill.files.push({ path, content });
    }
    skill.files.sort((a, b) => a.path.localeCompare(b.path));
    skills.push(skill);
  }
  return { skills, leftOut };
}

// ─── JSON ────────────────────────────────────────────────────────────────────

function fromJson(text: string, fileName: string): ParsedUpload | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0 || list.length > SKILLS_PER_UPLOAD_MAX) return null;
  const skills: ParsedSkill[] = [];
  const leftOut: string[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    const instructions = typeof record.instructions === "string" ? record.instructions : typeof record.content === "string" ? record.content : null;
    if (instructions === null) return null;
    const skill = parseSkillMarkdown(instructions.replace(/\r\n?/g, "\n"), nameFromFile(fileName));
    if (typeof record.name === "string" && oneLine(record.name)) skill.name = cut(oneLine(record.name), SKILL_NAME_MAX);
    if (typeof record.description === "string" && oneLine(record.description)) {
      skill.description = cut(oneLine(record.description), SKILL_DESCRIPTION_MAX);
    }
    if (Array.isArray(record.files)) {
      let total = 0;
      for (const file of record.files) {
        const f = file as { path?: unknown; content?: unknown };
        const path = typeof f?.path === "string" ? safeArchivePath(f.path) : null;
        if (!path || typeof f.content !== "string") {
          leftOut.push(`${String(f?.path ?? "a file")}: it has no usable path or no text`);
          continue;
        }
        const size = Buffer.byteLength(f.content, "utf8");
        if (size > SKILL_FILE_MAX_BYTES || skill.files.length >= SKILL_FILES_MAX || total + size > SKILL_FILES_TOTAL_MAX) {
          leftOut.push(`${path}: it is more than a skill keeps`);
          continue;
        }
        if (skill.files.some((existing) => existing.path === path)) continue;
        total += size;
        skill.files.push({ path, content: f.content.replace(/\r\n?/g, "\n") });
      }
    }
    skills.push(skill);
  }
  return { skills, leftOut };
}

// ─── Any upload ──────────────────────────────────────────────────────────────

/**
 * What an uploaded file holds: one skill, or the skills of an archive. The
 * kind is read from the bytes, not from the file's name: a .skill is a ZIP.
 */
export function parseSkillUpload(fileName: string, bytes: Buffer): ParsedUpload {
  if (bytes.length === 0) throw new SkillParseError("The file is empty.");
  if (bytes.length > SKILL_UPLOAD_MAX_BYTES) {
    throw new SkillParseError(`A skill can be at most ${Math.floor(SKILL_UPLOAD_MAX_BYTES / (1024 * 1024))} MB.`);
  }
  if (looksLikeZip(bytes)) return fromArchive(bytes, fileName);
  const text = decodeText(bytes);
  if (text === null) {
    throw new SkillParseError(
      "This is neither text nor a ZIP archive. A skill is a SKILL.md (Markdown), or a .skill or .zip of a folder with a SKILL.md in it.",
    );
  }
  if (/\.json$/i.test(fileName) || /^\s*[[{]/.test(text)) {
    const parsed = fromJson(text, fileName);
    if (parsed) return parsed;
    if (/\.json$/i.test(fileName)) {
      throw new SkillParseError('A skill as JSON is an object with "name", "description" and "instructions".');
    }
  }
  return { skills: [parseSkillMarkdown(text, nameFromFile(fileName))], leftOut: [] };
}

/** A skill as the SKILL.md it would be uploaded as. */
export function skillMarkdown(skill: Pick<ParsedSkill, "name" | "description" | "instructions" | "metadata">): string {
  const quote = (value: string) => (/^[A-Za-z0-9][^:#\n"']*$/.test(value) ? value : JSON.stringify(value));
  const lines = ["---", `name: ${quote(skill.name)}`, `description: ${quote(skill.description)}`];
  for (const [key, value] of Object.entries(skill.metadata)) {
    if (/^[A-Za-z0-9_-]+$/.test(key)) lines.push(`${key}: ${quote(value)}`);
  }
  lines.push("---", "", skill.instructions.trim(), "");
  return lines.join("\n");
}
