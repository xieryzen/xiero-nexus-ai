/**
 * Waiting for the limits of a task's models. Pure.
 *
 * A request to a model that answers "not now" (429, 503, 529) is sent again
 * after a wait of seconds (../retry.ts), and an agent whose model still does
 * not answer goes on with its next one. When none of them answers and at
 * least one said "not now", the limit is one that seconds do not end: the
 * allowance of an hour that is used up, a provider that is down for a while.
 * Failing the task then fails every task that depends on it, and the run
 * with them, over something that is over by itself a little later.
 *
 * So the task waits and asks its models again: after a minute, two, five, ten
 * and then every quarter of an hour, for an hour in all (RUN_LIMIT_WAIT_MINUTES;
 * 0 turns it off). It does not wait for a limit that the provider says lasts
 * longer than the time that is left: a quota for the day is not back in an
 * hour. A task that waited the whole time in vain fails, and the other tasks
 * of its run do not wait again: what is left of the run is done later, with
 * Continue, which keeps what the run finished.
 */

/** How long a task waits for its models' limits, when nothing is set. */
export const LIMIT_WAIT_DEFAULT_MINUTES = 60;
/** The longest that can be set: a day. */
export const LIMIT_WAIT_MAX_MINUTES = 24 * 60;

/**
 * The time a task waits for its models' limits, in milliseconds, from
 * RUN_LIMIT_WAIT_MINUTES: 0 ("0", "off", "false", "no") means that it does not
 * wait. `testSeconds` is for the checks of this app only: seconds instead of
 * minutes.
 */
export function limitWaitMs(setting: string | undefined | null, testSeconds?: string | null): number {
  const seconds = (testSeconds ?? "").trim();
  if (/^\d+(\.\d+)?$/.test(seconds)) return Math.round(Number(seconds) * 1000);
  const text = (setting ?? "").trim().toLowerCase();
  if (text === "") return LIMIT_WAIT_DEFAULT_MINUTES * 60_000;
  if (["0", "off", "false", "no"].includes(text)) return 0;
  const minutes = Number(text);
  if (!Number.isFinite(minutes) || minutes < 0) return LIMIT_WAIT_DEFAULT_MINUTES * 60_000;
  return Math.min(LIMIT_WAIT_MAX_MINUTES, Math.round(minutes)) * 60_000;
}

/** The waits of an hour, in minutes; the last one is taken again and again. Another total keeps the proportions. */
const STEPS = [1, 2, 5, 10, 15];
/** No wait is shorter than this. */
const SHORTEST_MS = 250;
/** A little more than a provider asks for: its limit is still full at the exact moment. */
const MARGIN_MS = 500;

/** What a model that said "not now" said about its limit (../upstream.ts). */
export interface LimitedModel {
  /** The wait it named. Null: none. */
  waitMs: number | null;
  /** Its limit is not one that some minutes end. */
  lasting: boolean;
}

/**
 * How long a task waits before it asks its models again. Null when it does
 * not wait: waiting is off, the time is used up, or none of the models that
 * said "not now" has a limit that can end in the time that is left.
 *
 * `round`: how often the task has waited already. `limited`: the models that
 * said "not now" the last time they were asked.
 */
export function nextLimitWait(opts: {
  round: number;
  waitedMs: number;
  totalMs: number;
  limited: readonly LimitedModel[];
}): number | null {
  const left = opts.totalMs - opts.waitedMs;
  if (!(opts.totalMs > 0) || left <= 0) return null;
  const open = opts.limited.filter((model) => !model.lasting && (model.waitMs === null || model.waitMs <= left));
  if (open.length === 0) return null;
  const step = STEPS[Math.min(Math.max(Math.trunc(opts.round), 0), STEPS.length - 1)]! * (opts.totalMs / 60);
  // When each of them named its wait, none is asked before the first of those waits is over.
  const named = open.every((model) => model.waitMs !== null)
    ? Math.min(...open.map((model) => model.waitMs as number)) + MARGIN_MS
    : 0;
  return Math.round(Math.min(left, Math.max(step, named, SHORTEST_MS)));
}

/**
 * What a task that waits says on its card. `message` is for everyone, and
 * speaks of no model; `full` is for those who are shown the setup.
 * `time`: how long until its models are asked again, in words.
 */
export function limitWaitNote(time: string, models: { limited: number; of: number }): { message: string; full: string } {
  return {
    message: `Not answered just now. Trying again in ${time}`,
    full:
      models.of <= 1
        ? `Its model says "not now" (limited, or busy). Asking it again in ${time}`
        : `None of its ${models.of} models answers: ${models.limited >= models.of ? "all" : models.limited} said "not now" (limited, or busy). Asking them again in ${time}`,
  };
}

/** One model of a task that did not answer, for the task's error. */
export interface ModelFailure {
  /** The model, as it is called, with its provider: "Qwen3.6-27B (OVHcloud AI Endpoints)". */
  model: string;
  error: string;
}

/**
 * What a task says when none of its models answered. With one model, what
 * that model said. With more, each of them with what it said: the last one
 * alone, which is all a task used to show, says nothing of why the first and
 * the second did not do the work. `waited`: what the task waited for their
 * limits, in words; empty when it did not wait.
 */
export function failureText(failures: readonly ModelFailure[], fallback: string, waited = ""): string {
  const note = waited ? `\n\nThe task waited ${waited} for the limit to end, and it did not.` : "";
  if (failures.length === 0) return fallback + note;
  if (failures.length === 1) return failures[0]!.error + note;
  return (
    `None of the ${failures.length} models of this task gave an answer` +
    (waited ? `, also after the task waited ${waited} for their limits.` : ".") +
    "\n" +
    failures.map((failure) => `• ${failure.model}: ${failure.error}`).join("\n")
  );
}
