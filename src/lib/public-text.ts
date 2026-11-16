/**
 * What is said to someone who is not shown how the installation is set up
 * (roles.ts: seesSetup). Pure: used by the server, and tested alone.
 *
 * Such a reader is not told which provider or model did their work, nor what
 * one answered. A sentence that would tell them is replaced by one that says
 * only that it did not work, and what to do. Everything else is left as it
 * is: that the tokens are used up, that a file is too large, that a task was
 * cancelled.
 */

/** What is said in place of a sentence that names the setup. */
export const NOT_NOW =
  "This could not be done just now. Try again in a moment; if it stays that way, tell an administrator.";

/** What is said when the installation has nothing that can do the job. */
export const NOT_SET_UP =
  "This installation cannot do that yet. An administrator has to set it up.";

/** What a running task says in place of a note that names the setup. */
export const WORKING = "Working";

/** Words that speak of the setup, whatever it is called. */
const SETUP_WORDS = /\b(?:providers?|models?|upstream|adapters?|gateway)\b/i;

/** The shortest name that is looked for: a shorter one is in too many words. */
const SHORTEST_NAME = 4;

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The forms a model's id is written in: as it is, without what stands before
 * its last "/" ("google/gemini-2.0-flash"), and without a ":suffix" after it
 * ("llama-3.3-70b:free").
 */
export function nameForms(name: string): string[] {
  const whole = name.trim();
  if (!whole) return [];
  const forms = [whole];
  const tail = whole.includes("/") ? whole.slice(whole.lastIndexOf("/") + 1) : whole;
  if (tail !== whole) forms.push(tail);
  const stem = tail.includes(":") ? tail.slice(0, tail.indexOf(":")) : tail;
  if (stem !== tail) forms.push(stem);
  return forms;
}

/**
 * One pattern that finds any of these names as a word of its own, in any
 * case. Null when there is no name long enough to look for.
 */
export function namesPattern(
  names: readonly (string | null | undefined)[],
  /** Words that are not looked for, though a provider or a model goes by them. */
  except: readonly string[] = [],
): RegExp | null {
  const skip = new Set(except.map((word) => word.toLowerCase()));
  const forms = new Set<string>();
  for (const name of names) {
    if (!name) continue;
    for (const form of nameForms(name)) {
      if (form.length >= SHORTEST_NAME && !skip.has(form.toLowerCase())) forms.add(form.toLowerCase());
    }
  }
  if (forms.size === 0) return null;
  // The longest first, so that a name is not taken for a shorter one inside it.
  const alternatives = [...forms].sort((a, b) => b.length - a.length).map(escape);
  return new RegExp(`(?<![A-Za-z0-9])(?:${alternatives.join("|")})(?![A-Za-z0-9])`, "i");
}

/** True when the text speaks of the setup: by one of its words, or by a name. */
export function namesSetup(text: string, names?: RegExp | null): boolean {
  return SETUP_WORDS.test(text) || Boolean(names && names.test(text));
}

/** The text without what stands in double quotes, straight or curly. */
export function withoutQuoted(text: string): string {
  return text.replace(/"[^"\n]*"|\u201c[^\u201d\n]*\u201d/g, '""');
}

/**
 * A message as it is said to someone who is not shown the setup: itself, or
 * `instead` when it speaks of the setup. Null stays null.
 *
 * `ownWords`: the message is one the app wrote about a request, and what it
 * has in quotes is what the reader named themselves (a title, a file). That
 * is not looked through, so that a document called "Business model" can be
 * spoken of. Not for a message that holds what a provider answered.
 */
export function publicText(
  text: string | null | undefined,
  names?: RegExp | null,
  instead: string = NOT_NOW,
  ownWords = false,
): string | null {
  if (text === null || text === undefined) return null;
  return namesSetup(ownWords ? withoutQuoted(text) : text, names) ? instead : text;
}

/**
 * The line an image, a video or a voice-over of a project leaves in writing,
 * without the model that made it: "Generated image with <model> (9:16).
 * Asset <id>." becomes "Generated image. Asset <id>.". The app writes that
 * line; any other text is returned as it is.
 */
export function withoutMaker(artifact: string): string {
  return artifact.replace(
    /^Generated (image|video|voice-over) with [^\n]*?(\. Asset [0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.)/,
    "Generated $1$2",
  );
}

/**
 * A workflow's description without the sentence the Reel template wrote at
 * its end before version 1.8: "The project needs a video model and an image
 * model, and the server needs ffmpeg." For someone who chooses no model that
 * is the app's to see to. The app wrote that sentence; any other text is
 * returned as it is.
 */
export function withoutNeeds(description: string): string {
  return description.replace(
    /\s*The project needs a video model(?: and an image model|, an image model and a speech model)(?:, and the server needs ffmpeg)?\.\s*$/,
    "",
  );
}

/**
 * What a provider said when the result of a run could not be put together:
 * the app writes "(Synthesis step failed: <that>)" in the result's place.
 * Null for any other result.
 */
export function synthesisFailure(deliverable: string): string | null {
  return /^\(Synthesis step failed: ([\s\S]*)\)$/.exec(deliverable)?.[1] ?? null;
}

/** What is said in the place of a result that could not be put together. */
export const NOT_PUT_TOGETHER = `(What the tasks made could not be put together into one deliverable just now. The output of each finished task is in the task. ${NOT_NOW})`;
