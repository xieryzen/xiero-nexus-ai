/**
 * What a task hands over, and what a reviewer is shown of it.
 *
 * An agent with tools may write its files itself and end with a few lines on
 * what it did. Those lines are not the work: the files are. This module says
 * which files a task wrote, what goes into a task's output file, and what the
 * reviewer is given to read. Pure: no database, so that it can be tested alone.
 */

// ─── The files a task wrote ──────────────────────────────────────────────────

/** The path in what write_file and edit_file answer: "Saved a/b.md (120 characters)." */
export function savedPath(result: string | null | undefined): string | null {
  const match = /^Saved (.+) \(\d+ characters\)\.$/.exec((result ?? "").trim());
  return match?.[1] ?? null;
}

/** The path in what delete_file answers: "Deleted a/b.md." */
export function deletedPath(result: string | null | undefined): string | null {
  const match = /^Deleted (.+)\.$/.exec((result ?? "").trim());
  return match?.[1] ?? null;
}

export interface FileToolCall {
  name: string;
  result: string | null | undefined;
  isError: boolean;
}

/**
 * Keeps up with the files a task has written: a call that saved a file adds
 * its path, one that deleted it takes it away again.
 */
export function noteFileCall(written: Set<string>, call: FileToolCall): void {
  if (call.isError) return;
  if (call.name === "write_file" || call.name === "edit_file") {
    const path = savedPath(call.result);
    if (path) written.add(path);
  } else if (call.name === "delete_file") {
    const path = deletedPath(call.result);
    if (path) written.delete(path);
  }
}

/** The files a task wrote and did not delete again, from its tool calls in order. */
export function pathsWritten(calls: FileToolCall[]): string[] {
  const written = new Set<string>();
  for (const call of calls) noteFileCall(written, call);
  return [...written];
}

// ─── A task's output file ────────────────────────────────────────────────────

// A fence line of Markdown: three or more backticks or tildes, and after an
// opening one the language.
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+.#-]*)[ \t]*$/;
/** Extensions of files that are documents: fences inside them belong to them. */
const DOCUMENTS = new Set(["", "md", "markdown", "mdx", "txt", "text", "rst"]);
/** What a fence around a whole document is labelled with. */
const DOCUMENT_LABELS = new Set(["markdown", "md", "mdx", "text", "txt"]);

function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * What is saved as a task's output file when the agent answered with the
 * file, instead of writing it with a tool.
 *
 * Models put a file into a code fence, and say a word before and after it.
 * In a file of code or data that is wrong twice: `plugin.yml` must not begin
 * with "```yaml", nor end with "I could not test it." So:
 *  - a file of code or data: when the answer holds exactly one fenced block,
 *    the block is the file;
 *  - a document (Markdown, text): only a fence around all of it is taken
 *    off, and only one that says it holds a document, or says nothing and
 *    has no fences inside. What a document says around its code stays.
 * Anything else is saved as it was answered.
 */
export function fileBody(path: string, answer: string): string {
  const lines = answer.replace(/\r\n/g, "\n").trim().split("\n");
  const fences: { at: number; mark: string; label: string }[] = [];
  lines.forEach((line, at) => {
    const match = FENCE.exec(line);
    if (match) fences.push({ at, mark: (match[1] ?? "`").charAt(0), label: (match[2] ?? "").toLowerCase() });
  });
  const first = fences[0];
  const last = fences[fences.length - 1];
  if (!first || !last || fences.length < 2) return answer;
  const inside = (from: number, to: number) => lines.slice(from + 1, to).join("\n");

  if (DOCUMENTS.has(extensionOf(path))) {
    const wrapsAll = first.at === 0 && last.at === lines.length - 1 && last.label === "" && last.mark === first.mark;
    if (!wrapsAll) return answer;
    const labelled = DOCUMENT_LABELS.has(first.label) && fences.length % 2 === 0;
    const bare = first.label === "" && fences.length === 2;
    if (!labelled && !bare) return answer;
    const body = inside(first.at, last.at);
    return body.trim() ? `${body}\n` : answer;
  }

  if (fences.length !== 2 || last.label !== "" || last.mark !== first.mark) return answer;
  const body = inside(first.at, last.at);
  return body.trim() ? `${body}\n` : answer;
}

/**
 * A task's deliverable when the agent saved its output file itself: the
 * file, and after it what the agent said at the end. An agent that answered
 * with the file as well is taken at its word.
 */
export function deliverableOfSavedFile(path: string, content: string, said: string): string {
  const note = said.trim();
  const body = content.trim();
  if (!note || note === body) return content;
  if (body && note.includes(body)) return said;
  return `${content.replace(/\s+$/, "")}\n\n[Saved as ${path} by the agent, which said: ${note}]`;
}

// ─── What the reviewer reads ─────────────────────────────────────────────────

export interface ReviewTask {
  seq: number;
  title: string;
  acceptanceCriteria: string | null | undefined;
  artifact: string | null | undefined;
  /** The file the task's deliverable is saved as, when it has one. */
  outputFile?: string | null;
  /** The files the task wrote with its tools. */
  wrote?: string[];
}

export interface ReviewFile {
  path: string;
  content: string;
}

export interface ReviewLimits {
  /** Characters of one deliverable or one file. */
  item: number;
  /** Characters of all of them together. */
  total: number;
  /** A deliverable or a file is not cut shorter than this to make room for more of them. */
  least: number;
}

export const REVIEW_LIMITS: ReviewLimits = { item: 8_000, total: 64_000, least: 1_200 };

/** A file shorter than this is not looked for inside a deliverable: a few words are found anywhere. */
const HELD_AT_LEAST = 20;

/** How the reviewer is told that it was not shown all of a text. */
export const CUT_MARK = "[cut here:";

/**
 * The tasks with their deliverables, and the files of the workspace, for the
 * reviewer. A reviewer that sees only what an agent said of a file ("I wrote
 * README.md") can pass nothing: it is shown the file.
 *
 * Room is shared: with many tasks and files each gets less, and what was cut
 * or left out is said, so that it is not taken for missing work. A file
 * whose content a deliverable already holds is not shown twice, and the
 * deliverable says that it is that file: a reviewer that is told a task has
 * a file, and is shown none, takes the file for missing.
 */
export function reviewMaterial(tasks: ReviewTask[], files: ReviewFile[], limits: ReviewLimits = REVIEW_LIMITS): string {
  const filesOf = (task: ReviewTask) => [...new Set([...(task.outputFile ? [task.outputFile] : []), ...(task.wrote ?? [])])];
  // Which tasks say that a file is theirs. Two files can hold the same words:
  // a deliverable is then the file of its own task, not the other one.
  const claimedBy = new Map<string, number[]>();
  for (const task of tasks) {
    for (const path of filesOf(task)) claimedBy.set(path, [...(claimedBy.get(path) ?? []), task.seq]);
  }
  const heldBy = (file: ReviewFile, task: ReviewTask) => {
    const body = file.content.trim();
    if (body.length < HELD_AT_LEAST || !(task.artifact ?? "").includes(body)) return false;
    const claimed = claimedBy.get(file.path);
    return !claimed || claimed.includes(task.seq);
  };
  const repeated = files.filter((file) => tasks.some((task) => heldBy(file, task))).map((file) => file.path);
  const others = files
    .filter((file) => file.content.trim() !== "" && !repeated.includes(file.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  const items = tasks.length + others.length;
  const each = Math.max(limits.least, Math.min(limits.item, Math.floor(limits.total / Math.max(1, items))));
  let left = limits.total;
  const show = (text: string): string => {
    const shown = text.slice(0, Math.max(0, Math.min(each, left)));
    left -= shown.length;
    const more = text.length - shown.length;
    return more > 0 ? `${shown}\n${CUT_MARK} ${more} more characters were not shown to you]` : shown;
  };

  const parts = tasks.map((task) => {
    const wrote = filesOf(task);
    const holds = files.filter((file) => heldBy(file, task)).map((file) => file.path).sort();
    return (
      `## ${task.seq}. ${task.title}\n` +
      `Acceptance criteria: ${task.acceptanceCriteria || "(none)"}\n` +
      (wrote.length > 0 ? `Files of this task: ${wrote.join(", ")}\n` : "") +
      (holds.length > 0
        ? `Deliverable (it holds ${holds.length === 1 ? "the file" : "the files"} ${holds.join(", ")}, as saved in the workspace):\n`
        : "Deliverable:\n") +
      show(task.artifact ?? "")
    );
  });

  if (others.length > 0 || repeated.length > 0) {
    const shown: string[] = [];
    const leftOut: string[] = [];
    for (const file of others) {
      // A file is shown when there is room for it, or for a part worth reading.
      if (left < Math.min(limits.least, file.content.length)) {
        leftOut.push(`${file.path} (${file.content.length} characters)`);
        continue;
      }
      shown.push(`#### File: ${file.path} (${file.content.length} characters)\n${show(file.content)}`);
    }
    parts.push(
      "### Files in the project workspace, as they are now" +
        (shown.length > 0 ? `\n\n${shown.join("\n\n")}` : "") +
        (repeated.length > 0 ? `\n\nShown above, in the deliverable that holds it, and not again here: ${[...repeated].sort().join(", ")}` : "") +
        (leftOut.length > 0 ? `\n\nNot shown to you, for want of room: ${leftOut.join(", ")}` : ""),
    );
  }
  return parts.join("\n\n");
}

/** The files of the workspace by name and size, for the manager's summing up. */
export function fileList(files: { path: string; size: number }[], most = 80): string {
  if (files.length === 0) return "";
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const lines = sorted.slice(0, most).map((file) => `- ${file.path} (${file.size} characters)`);
  if (sorted.length > most) lines.push(`- and ${sorted.length - most} more`);
  return lines.join("\n");
}
