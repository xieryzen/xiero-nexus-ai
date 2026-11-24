import "server-only";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { execRuns, workspaces, type BuiltFile, type ExecRun } from "@/db/schema";
import { AppError } from "../errors";
import { allFiles, recordExec } from "../workspace";
import { getExecutor, type ExecResult } from "../workspace/executor";
import { sourceHashOf, storeBuilt } from "./built";
import { buildOf, keepPatterns, type BuildPlan } from "./kinds";

/**
 * Running a program on a copy of a project's files, and keeping the packages
 * it leaves behind: the way an agent's `run_command`, the Execute box of the
 * workspace and the build of a project all go.
 *
 * The program runs in the sandbox runner, never on this server. What it
 * prints is kept as a record (exec_runs) with a hash of the files it ran on;
 * the packages it made are kept as the project's built files.
 */

export interface RunContext {
  /** The project the workspace belongs to. Without one, nothing is kept. */
  projectId: string | null;
  workspaceId: string;
  userId: string | null;
  /** The task whose agent runs the program. */
  taskId?: string | null;
}

export interface RunOutcome {
  result: ExecResult;
  /** The packages that were kept as the project's built files. */
  kept: BuiltFile[];
  /** Files that fit and were not kept, each with the reason. */
  refused: { path: string; reason: string }[];
  sourceHash: string;
}

/** Errors that say the request itself cannot be done: nothing ran, and nothing is recorded. */
const NOTHING_RAN = new Set(["execution_disabled", "command_not_allowed", "invalid_command"]);

export async function runAndKeep(ctx: RunContext, command: string, timeoutMs: number, keep: readonly string[] = []): Promise<RunOutcome> {
  const executor = getExecutor();
  const files = allFiles(ctx.workspaceId).map((f) => ({ path: f.path, content: f.content }));
  const sourceHash = sourceHashOf(files);
  let result: ExecResult;
  try {
    result = await executor.run({ files, command, timeoutMs, keep: keepPatterns(keep) });
  } catch (err) {
    if (!(err instanceof AppError && NOTHING_RAN.has(err.code))) {
      recordExec({
        workspaceId: ctx.workspaceId,
        command,
        status: "error",
        exitCode: null,
        stdout: null,
        stderr: err instanceof AppError ? err.message : "Execution failed",
        durationMs: null,
        sourceHash,
        createdBy: ctx.userId,
      });
    }
    throw err;
  }
  recordExec({
    workspaceId: ctx.workspaceId,
    command,
    status: result.exitCode === 0 ? "ok" : "error",
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    sourceHash,
    createdBy: ctx.userId,
  });
  // What a program that failed left behind is not a package anyone asked for.
  if (!ctx.projectId || result.exitCode !== 0 || result.kept.length === 0) {
    return { result, kept: [], refused: result.notKept, sourceHash };
  }
  const stored = storeBuilt({
    projectId: ctx.projectId,
    files: result.kept,
    command,
    sourceHash,
    taskId: ctx.taskId ?? null,
    userId: ctx.userId,
  });
  return { result, kept: stored.kept, refused: [...result.notKept, ...stored.refused], sourceHash };
}

// ─── The build of a project ──────────────────────────────────────────────────

/** The end of what a program printed: where a build says what went wrong. */
export function logTail(run: Pick<ExecRun, "stdout" | "stderr">, max = 6000): string {
  const text = [run.stdout?.trim(), run.stderr?.trim()].filter(Boolean).join("\n").trim();
  return text.length > max ? `… (${text.length - max} characters before this are left out)\n${text.slice(-max)}` : text;
}

export interface LastBuild {
  ok: boolean;
  exitCode: number | null;
  at: number;
  durationMs: number | null;
  /** The end of what it printed. */
  log: string;
  /** It was run on the files as they are now. */
  current: boolean;
}

export interface BuildState {
  plan: BuildPlan;
  /** Whether this server has a runner to build with. */
  runner: boolean;
  /** A build of this project is under way. */
  running: boolean;
  /** The last time the project was built, with the command of the plan. */
  last: LastBuild | null;
}

function building(): Set<string> {
  const holder = globalThis as { __xieroNexusBuilding?: Set<string> };
  holder.__xieroNexusBuilding ??= new Set<string>();
  return holder.__xieroNexusBuilding;
}

export function isBuilding(projectId: string): boolean {
  return building().has(projectId);
}

/** How a project is built and how its last build went; null when its files are not something that is built. */
export function buildStateOf(projectId: string, workspaceId: string, files: readonly { path: string; content: string }[]): BuildState | null {
  const plan = buildOf(files.map((f) => f.path));
  if (!plan) return null;
  const run = db
    .select()
    .from(execRuns)
    .where(eq(execRuns.workspaceId, workspaceId))
    .orderBy(desc(execRuns.createdAt), desc(execRuns.id))
    .limit(60)
    .all()
    .find((r) => r.command === plan.command);
  return {
    plan,
    runner: getExecutor().enabled,
    running: isBuilding(projectId),
    last: run
      ? {
          ok: run.status === "ok",
          exitCode: run.exitCode,
          at: run.createdAt.getTime(),
          durationMs: run.durationMs,
          log: logTail(run),
          current: run.sourceHash !== null && run.sourceHash === sourceHashOf(files),
        }
      : null,
  };
}

export interface BuildOutcome {
  plan: BuildPlan;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  log: string;
  kept: BuiltFile[];
  refused: { path: string; reason: string }[];
}

/**
 * Build a project: the command its build file calls for, in the runner, and
 * the packages it leaves behind kept. One build of a project at a time.
 * Throws when there is nothing to build (400), no runner (400), a build under
 * way (409), or the runner cannot be reached (502).
 */
export async function buildProject(ctx: RunContext & { projectId: string }): Promise<BuildOutcome> {
  const plan = buildOf(allFiles(ctx.workspaceId).map((f) => f.path));
  if (!plan) throw new AppError(400, "nothing_to_build", "The files of this project are not something that is built: there is no Gradle or Maven build file among them.");
  const executor = getExecutor();
  if (!executor.enabled) throw new AppError(400, "execution_disabled", "This server has no runner to build with.");
  const now = building();
  if (now.has(ctx.projectId)) throw new AppError(409, "build_active", "This project is being built already.");
  now.add(ctx.projectId);
  try {
    const outcome = await runAndKeep(ctx, plan.command, executor.maxTimeoutMs, plan.outputs);
    return {
      plan,
      ok: outcome.result.exitCode === 0,
      exitCode: outcome.result.exitCode,
      timedOut: outcome.result.timedOut,
      durationMs: outcome.result.durationMs,
      log: logTail(outcome.result),
      kept: outcome.kept,
      refused: outcome.refused,
    };
  } finally {
    now.delete(ctx.projectId);
  }
}

/**
 * Whether a project still waits for its package: its files are something
 * that is built, this server can build, and the last build of the files as
 * they are now did not succeed, or there was none. A run that continues such
 * a project has something to do although every task is done: build it, and
 * have what stops the build put right.
 */
export function buildPending(projectId: string): boolean {
  if (!getExecutor().enabled) return false;
  const workspace = db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.projectId, projectId)).get();
  if (!workspace) return false;
  const state = buildStateOf(projectId, workspace.id, allFiles(workspace.id));
  return state !== null && !(state.last?.ok === true && state.last.current);
}
