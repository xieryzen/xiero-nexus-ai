import type { ChatMessage, ChatResult } from "../adapters/types";

/**
 * Answers that are whole.
 *
 * A model writes up to a length limit of its own, or of its provider, and
 * stops there: in the middle of a sentence, of a file, of a call. It says so
 * with its reason for stopping. Taken as it comes, half a document is handed
 * over as the finished one. Here: how to tell that an answer was cut, what
 * the model is asked then, and how the pieces are put together.
 *
 * Pure: used by the tool loop, by the work of a project and by the tests.
 */

/** The reasons for stopping that mean "the length limit of one reply", as the providers write them. */
const CUT_REASONS = new Set(["length", "max_tokens", "max_output_tokens", "max_completion_tokens", "max_length", "token_limit"]);

/** Whether a model stopped because it reached the length limit of one reply, not because it was done. */
export function wasCut(finishReason: string | null | undefined): boolean {
  return typeof finishReason === "string" && CUT_REASONS.has(finishReason.trim().toLowerCase());
}

/** How often an answer that was cut is asked to go on. */
export const DEFAULT_MAX_CONTINUATIONS = 8;

/** What a model is told when its answer was cut. */
export const CONTINUE =
  "Your reply was cut off: it reached the length limit of one reply. Continue it from exactly where it stopped. " +
  "Begin with the very next character, in the middle of the word or of the line if that is where it stopped. " +
  "Do not repeat anything you have written, do not start again, and write no introduction and no remark about continuing: " +
  "what you write now is put directly after what is there.";

/** What is put under an answer that is still cut when it may go on no more. */
export const CUT_NOTE = "[This was cut off at the length limit of the model, and is not complete.]";

const letters = (text: string) => text.replace(/[^\p{L}]/gu, "").length;
const solid = (text: string) => text.replace(/\s/g, "").length;

/** Whether a text is the same few characters again and again: "false, false, ", "|---|---", "0 0 0 ". */
function periodic(text: string): boolean {
  for (let period = 1; period * 2 <= text.length; period++) {
    let same = true;
    for (let i = period; i < text.length; i++) {
      if (text[i] !== text[i - period]) {
        same = false;
        break;
      }
    }
    if (same) return true;
  }
  return false;
}

/**
 * How much of the start of `more` only says again what `before` ends with.
 *
 * A model that goes on after a cut often begins once more at the line, the
 * sentence or the word it was cut in. Only that is looked for: a repeat that
 * begins where a line, a sentence or a word of `before` begins, and runs to
 * its very end. Text that merely looks alike is left alone, so an answer that
 * went on correctly loses nothing: a row of dashes or a list of the same
 * values, where the next piece of the pattern looks like the last one; the
 * same closing tag on two lines; a number or a short word that doubles.
 */
export function repeatedStart(before: string, more: string): number {
  // Cut at the end of a line: there is no unfinished line to begin again.
  if (!before || !more || /\n\s*$/.test(before)) return 0;
  const window = before.slice(-2000);
  const starts: { at: number; kind: "line" | "sentence" | "word" }[] = [];
  for (let i = 0; i < window.length; i++) {
    const prev = window[i - 1];
    if (i === 0 && window.length === before.length) starts.push({ at: 0, kind: "line" });
    else if (prev === "\n") starts.push({ at: i, kind: "line" });
    else if (prev === " " && /[.!?:;]/.test(window[i - 2] ?? "")) starts.push({ at: i, kind: "sentence" });
    else if (prev === " " || prev === "\t") starts.push({ at: i, kind: "word" });
  }
  // The longest repeat first: the earliest place it can begin.
  for (const start of starts) {
    const piece = window.slice(start.at);
    if (!more.startsWith(piece)) continue;
    // In a pattern that repeats, what comes next looks like what is there: nothing can be told.
    if (periodic(piece)) continue;
    // A line or a sentence begun again: a few characters of substance are enough to know it.
    if (start.kind !== "word" && solid(piece) >= 8) return piece.length;
    // A word begun again: only letters, and enough of them that it is no chance ("mama", "1010").
    if (/^\p{L}+$/u.test(piece) && letters(piece) >= 5) return piece.length;
    if (start.kind === "word" && solid(piece) >= 16 && letters(piece) >= 10) return piece.length;
  }
  return 0;
}

/** Whether a text ends inside a fenced block of code. */
function insideFence(text: string): boolean {
  let open = false;
  for (const line of text.split("\n")) if (/^\s*(```|~~~)/.test(line)) open = !open;
  return open;
}

/**
 * An answer and what the model wrote when it was asked to go on, as one text.
 * What is said again is left out once, and a block of code that was open is
 * not opened a second time.
 */
export function joinParts(before: string, more: string): string {
  if (!before) return more;
  if (!more) return before;
  let rest = more;
  if (insideFence(before)) {
    // The model opened the block again, by its language, before going on in it.
    // A mark without a language is the one that closes the block: it stays.
    const reopened = /^\s*(```|~~~)[^\n`\s][^\n`]*\n/.exec(rest);
    if (reopened && /\S/.test(rest.slice(reopened[0].length))) rest = rest.slice(reopened[0].length);
  }
  return before + rest.slice(repeatedStart(before, rest));
}

export interface WholeAnswer {
  /** The answer, with what was written when it went on. */
  content: string;
  /** How often it was cut and went on. */
  continued: number;
  /** Whether it is still cut: it may go on no more, or going on failed. */
  cut: boolean;
  /** The last reply as it came. */
  last: ChatResult;
}

/**
 * Ask a model, and ask it to go on for as long as its answer is cut at the
 * length limit of one reply. For a request without tools; the tool loop does
 * the same for the answer at its end.
 *
 * `ask` is one model call. It is given the conversation with what was written
 * so far and the request to go on. A call that fails after part of the answer
 * is there does not lose that part: the answer comes back as cut.
 */
export async function askWhole(
  ask: (messages: ChatMessage[], part: number) => Promise<ChatResult>,
  messages: ChatMessage[],
  opts: { max?: number; stop?: () => boolean } = {},
): Promise<WholeAnswer> {
  const max = Math.max(0, opts.max ?? DEFAULT_MAX_CONTINUATIONS);
  const conversation = [...messages];
  let last = await ask(conversation, 0);
  let content = last.content;
  let continued = 0;
  while (wasCut(last.finishReason) && last.content.trim()) {
    if (continued >= max || opts.stop?.()) return { content, continued, cut: true, last };
    conversation.push({ role: "assistant", content: last.content, ...(last.raw ? { raw: last.raw } : {}) }, { role: "user", content: CONTINUE });
    let more: ChatResult;
    try {
      more = await ask(conversation, continued + 1);
    } catch {
      return { content, continued, cut: true, last };
    }
    continued++;
    // Asked to go on, it wrote nothing: what is there is all there will be.
    if (!more.content.trim()) return { content, continued, cut: true, last: more };
    content = joinParts(content, more.content);
    last = more;
  }
  return { content, continued, cut: false, last };
}
