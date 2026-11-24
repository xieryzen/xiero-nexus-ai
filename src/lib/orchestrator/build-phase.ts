/**
 * The build at the end of a run, in words and choices: what is asked of the
 * agent that has to make a failing build work, who that agent is, and what
 * the manager and the reviewer are told about how the build went. Pure, so
 * that it can be tested without a runner or a model.
 */
import { sizeLabel, type BuildPlan } from "../result/kinds";

/** How often a run gives the task of making the build work, before it says that the build fails. */
export const BUILD_FIX_ROUNDS = 2;

/** How much of what a build printed an agent is shown. */
const FIX_LOG_CHARS = 5000;
/** And how much the manager and the reviewer are. */
const NOTE_LOG_CHARS = 1500;

function end(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `… (the start is left out)\n${trimmed.slice(-max)}` : trimmed;
}

export function fixTitle(round: number): string {
  return round <= 1 ? "Make the project build" : `Make the project build (attempt ${round})`;
}

/** Whether a task is one of those: by its title, which the app wrote. */
export function isFixTask(title: string): boolean {
  return /^Make the project build( \(attempt \d+\))?$/.test(title);
}

/** What the agent is asked to do about a build that fails. */
export function fixObjective(plan: BuildPlan, log: string, canRun: boolean): string {
  return (
    `The files of this project are built into a package with ${plan.label} (${plan.file}), and the build fails. Make it build.\n\n` +
    `The build command:\n${plan.command}\n\n` +
    `What the build said (its end):\n${end(log, FIX_LOG_CHARS) || "(it printed nothing)"}\n\n` +
    "Read the files the errors name, find what is wrong, and correct it in the files. " +
    (canRun
      ? "Then run the build command with run_command, read what it says, and go on until it exits with code 0. " +
        "The build runs with the tools that are installed where run_command runs: `gradle --version`, `mvn -v` and `java -version` say which they are, " +
        "and a build file has to fit them (there is no wrapper, and no other version is fetched). "
      : "You cannot run the build yourself: correct everything the output names, and check each change against the files it touches. ") +
    "Change only what the build needs: do not take a feature out to make an error go away, and do not rewrite files that are not part of the problem. " +
    "When you are done, answer in a few lines: what was wrong, what you changed, and whether the build succeeds now."
  );
}

export const FIX_ACCEPTANCE = "The build command exits with code 0 and leaves the package. Nothing the project is to do was removed to get there.";

/** The tools a task is handed whatever its agent has ticked, as kept on its row: {"tools":["run_command"]}. */
export function grantedTools(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as { tools?: unknown };
    return Array.isArray(value?.tools) ? value.tools.filter((t): t is string => typeof t === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}

export interface FixCandidate {
  agentId: string | null;
  /** The task's number: of two that fit, the later one knows the files as they are. */
  seq: number;
  /** The files the task wrote. */
  wrote: readonly string[];
  /** Whether its agent can write files: without that it cannot correct one. */
  canWrite: boolean;
}

/**
 * The agent that is to make the build work: the one whose task wrote the
 * build file, else the one that wrote the most files, else any that can
 * write. Null when no agent of the run can write a file.
 */
export function pickFixer(candidates: readonly FixCandidate[], buildFile: string): string | null {
  const able = candidates.filter((c) => c.agentId && c.canWrite);
  if (able.length === 0) return null;
  const wroteBuild = able.filter((c) => c.wrote.includes(buildFile)).sort((a, b) => b.seq - a.seq)[0];
  if (wroteBuild) return wroteBuild.agentId;
  const counts = new Map<string, number>();
  for (const c of able) counts.set(c.agentId!, (counts.get(c.agentId!) ?? 0) + c.wrote.length);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

export interface BuildReport {
  plan: BuildPlan;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  log: string;
  kept: { path: string; sizeBytes: number }[];
  /** How many times an agent was given the task of making it work. */
  fixRounds: number;
  /** Why it was not built at all, when it was not. */
  notBuilt?: string;
}

/** What the manager and the reviewer are told about the build. */
export function buildNote(report: BuildReport): string {
  const how = `${report.plan.label} (${report.plan.command})`;
  if (report.notBuilt) return `The project was not built with ${how}: ${report.notBuilt}`;
  if (report.ok) {
    const made =
      report.kept.length > 0
        ? `It made ${report.kept.map((k) => `${k.path} (${sizeLabel(k.sizeBytes)})`).join(", ")}, which the person downloads from the project page.`
        : "It left no package behind.";
    return (
      `The project was built with ${how}, and the build succeeded` +
      (report.fixRounds > 0 ? ` after ${report.fixRounds === 1 ? "one task" : `${report.fixRounds} tasks`} that corrected what stopped it` : "") +
      `. ${made} Whether the package does what it should was not tried: it was compiled and packed, not run.`
    );
  }
  return (
    `The project was built with ${how}, and the build FAILED` +
    (report.timedOut ? " (its time was up)" : report.exitCode !== null ? ` (exit code ${report.exitCode})` : "") +
    (report.fixRounds > 0 ? `, also after ${report.fixRounds === 1 ? "one task" : `${report.fixRounds} tasks`} that tried to correct it` : "") +
    ". There is no package: the person has the source files, and they do not build as they are.\n" +
    `What the build said (its end):\n${end(report.log, NOTE_LOG_CHARS) || "(it printed nothing)"}`
  );
}
