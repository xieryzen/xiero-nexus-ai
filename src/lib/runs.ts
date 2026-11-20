import { textFor } from "./shown";
import "server-only";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { agentRuns, projectRuns, projects, projectTasks, toolCalls, type Project, type ProjectRun } from "@/db/schema";
import { AppError } from "./errors";
import { notify } from "./notifications";
import { prepareRun } from "./orchestrator";
import { publish } from "./run-bus";
import { runtime } from "./runtime";
import { assertTokensLeft } from "./tokens";
import { kickWorker } from "./worker";

/**
 * Starting, stopping and listing project runs.
 *
 * Starting a run does not execute it: it puts the run in the queue, and the
 * background worker picks it up within moments. The run then goes on whether
 * or not the page that started it stays open.
 *
 * A run starts anew, with a plan of its own, or it continues the run before
 * it: the tasks that succeeded there are kept with what they made, and only
 * the others are done. That is for a run that stopped half way, at a
 * provider's limit, at the account's tokens, or because someone stopped it:
 * doing all of it again spends the same allowance a second time, and may
 * well stop at the same place.
 */

export const MAX_RUN_INPUT_CHARS = 4000;

export interface StartRunOptions {
  trigger: ProjectRun["trigger"];
  /** The user who asked for the run. Null for a schedule whose creator is gone. */
  requestedBy?: string | null;
  /** An extra instruction for this run only. */
  input?: string | null;
  scheduleId?: string | null;
  apiKeyId?: string | null;
  /**
   * Go on with the tasks of the last run instead of planning anew: the ones
   * that succeeded are kept, the others are done again. Refused (409) when
   * there is nothing to go on with.
   */
  continueLast?: boolean;
}

/** The tasks a project has from its last run. */
export interface Continuation {
  total: number;
  /** The tasks that succeeded: a run that continues keeps them. */
  done: number;
  /** The tasks it would do. */
  left: number;
}

/** What a run that continues would find: the project's tasks, and how many of them succeeded. */
export function tasksToContinue(projectId: string): Continuation {
  const states = db.select({ status: projectTasks.status }).from(projectTasks).where(eq(projectTasks.projectId, projectId)).all();
  const done = states.filter((t) => t.status === "succeeded").length;
  return { total: states.length, done, left: states.length - done };
}

export interface StartRunResult {
  run: ProjectRun;
  /**
   * `queued`: the worker will execute it. `needs_approval`: the project asks
   * for an approval before each run and has none. `failed`: the project
   * cannot run as it is set up; `message` says why.
   */
  outcome: "queued" | "needs_approval" | "failed";
  message?: string;
}

function link(projectId: string): string {
  return `/dashboard/projects/${projectId}`;
}

/**
 * Queue a run of a project. Throws 409 when one is waiting or in progress,
 * and, for a run that is to continue the last one, when there is nothing to
 * go on with.
 */
export function startRun(project: Project, opts: StartRunOptions): StartRunResult {
  // A run spends the tokens of the account the project belongs to: with none
  // left it is refused (402), and nothing about the project changes.
  assertTokensLeft(project.createdBy, opts.requestedBy === project.createdBy ? "yours" : "project");
  const continues = opts.continueLast === true;
  let input = opts.input?.trim() ? opts.input.trim().slice(0, MAX_RUN_INPUT_CHARS) : null;
  if (continues && input === null) {
    // The tasks were planned with the instruction of the run they are from,
    // and the ones that are left are done with it too, unless a new one is given.
    input = listRuns(project.id, 1)[0]?.input ?? null;
  }
  const base = {
    projectId: project.id,
    trigger: opts.trigger,
    scheduleId: opts.scheduleId ?? null,
    apiKeyId: opts.apiKeyId ?? null,
    requestedBy: opts.requestedBy ?? null,
    input,
    continued: continues,
  };
  // A run nobody is watching ends in the owner's notifications.
  const unattended = opts.trigger !== "manual";

  const result = db.transaction((tx): StartRunResult => {
    const active = tx
      .select({ id: projectRuns.id })
      .from(projectRuns)
      .where(and(eq(projectRuns.projectId, project.id), inArray(projectRuns.status, ["queued", "running"])))
      .get();
    if (active) throw new AppError(409, "run_active", "This project is already running");

    // What a run that continues goes on with. Looked at before anything is
    // written: a request that cannot be met leaves no run behind.
    const tasks = continues
      ? tx
          .select({ status: projectTasks.status, promptTokens: projectTasks.promptTokens, completionTokens: projectTasks.completionTokens })
          .from(projectTasks)
          .where(eq(projectTasks.projectId, project.id))
          .all()
      : [];
    if (continues) {
      if (tasks.length === 0) {
        throw new AppError(409, "nothing_to_continue", "This project has no tasks from an earlier run to go on with. Run it.");
      }
      if (project.status === "succeeded" && tasks.every((t) => t.status === "succeeded")) {
        throw new AppError(409, "nothing_to_continue", "Every task of the last run succeeded: there is nothing left to do. Run the project again to start anew.");
      }
    }

    const now = new Date();
    try {
      prepareRun(project);
    } catch (err) {
      const message = err instanceof AppError ? err.message : "The project cannot run";
      // As before: the results of the last run stay where they are.
      tx.update(projects)
        .set({ status: "failed", error: message, finishedAt: now, updatedAt: now })
        .where(eq(projects.id, project.id))
        .run();
      const run = tx
        .insert(projectRuns)
        .values({ ...base, status: "failed", error: message, startedAt: now, finishedAt: now })
        .returning()
        .get();
      return { run, outcome: "failed", message };
    }

    if (project.requiresApproval && !project.approved) {
      tx.update(projects)
        .set({ status: "needs_approval", updatedAt: now })
        .where(eq(projects.id, project.id))
        .run();
      const run = tx
        .insert(projectRuns)
        .values({ ...base, status: "needs_approval", finishedAt: now })
        .returning()
        .get();
      return { run, outcome: "needs_approval" };
    }

    // What the tasks that are kept used: the project goes on counting it, the
    // new run counts what it uses itself.
    let kept = 0;
    if (continues) {
      // The tasks that succeeded stay as they are, with what they made. The
      // others go back in the queue and start over: what went wrong, and what
      // each model said, is of the run that ended. (What a task did on a
      // server or in a browser is not undone, and stays on record: its agent
      // is told of it when it starts.)
      for (const t of tasks) if (t.status === "succeeded") kept += (t.promptTokens ?? 0) + (t.completionTokens ?? 0);
      const again = tx
        .select({ id: projectTasks.id })
        .from(projectTasks)
        .where(and(eq(projectTasks.projectId, project.id), ne(projectTasks.status, "succeeded")))
        .all()
        .map((t) => t.id);
      if (again.length > 0) {
        tx.delete(agentRuns).where(inArray(agentRuns.taskId, again)).run();
        tx.delete(toolCalls).where(inArray(toolCalls.taskId, again)).run();
        tx.update(projectTasks)
          .set({
            status: "queued",
            error: null,
            artifact: null,
            attempts: 0,
            promptTokens: null,
            completionTokens: null,
            steps: 0,
            toolCallCount: 0,
            updatedAt: now,
          })
          .where(inArray(projectTasks.id, again))
          .run();
      }
    } else {
      // The last run's tasks make way for this one's. What the last run
      // delivered stays in the run history.
      tx.delete(agentRuns).where(eq(agentRuns.projectId, project.id)).run();
      tx.delete(projectTasks).where(eq(projectTasks.projectId, project.id)).run();
    }
    tx.update(projects)
      .set({
        status: "queued",
        // An approval is for one run.
        approved: project.requiresApproval ? false : project.approved,
        error: null,
        finalDeliverable: null,
        reviewNotes: null,
        tokensUsed: kept,
        startedAt: null,
        finishedAt: null,
        updatedAt: now,
      })
      .where(eq(projects.id, project.id))
      .run();
    const run = tx.insert(projectRuns).values({ ...base, status: "queued", tokensBefore: kept }).returning().get();
    return { run, outcome: "queued" };
  });

  runtime().cancelled.delete(project.id);
  if (result.outcome === "queued") {
    kickWorker();
  } else if (unattended) {
    notify(project.createdBy, {
      kind: "run",
      level: result.outcome === "failed" ? "error" : "warning",
      title:
        result.outcome === "failed"
          ? `Run could not start: ${project.title}`
          : `Run is waiting for approval: ${project.title}`,
      problem: result.outcome === "failed" ? result.message : null,
      body:
        result.outcome === "failed"
          ? null
          : "This project asks for an approval before each run. Approve it, then run it.",
      link: link(project.id),
    });
  }
  return result;
}

/**
 * Ask a project's run to stop. A run that has not started is ended here; one
 * in progress stops at its next step. Returns false when nothing is running.
 */
export function cancelRun(projectId: string): boolean {
  const run = db
    .select()
    .from(projectRuns)
    .where(and(eq(projectRuns.projectId, projectId), inArray(projectRuns.status, ["queued", "running"])))
    .orderBy(desc(projectRuns.createdAt))
    .get();
  if (!run) return false;

  if (run.status === "queued") {
    const now = new Date();
    const ended = db
      .update(projectRuns)
      .set({ status: "cancelled", cancelRequested: true, finishedAt: now })
      .where(and(eq(projectRuns.id, run.id), eq(projectRuns.status, "queued")))
      .returning()
      .get();
    if (ended) {
      db.update(projects)
        .set({ status: "cancelled", finishedAt: now, updatedAt: now })
        .where(eq(projects.id, projectId))
        .run();
      publish(projectId, { type: "status", status: "cancelled" });
      publish(projectId, { type: "done", status: "cancelled" });
      return true;
    }
    // The worker took it in this very moment: stop it as a run in progress.
  }
  db.update(projectRuns).set({ cancelRequested: true }).where(eq(projectRuns.id, run.id)).run();
  runtime().cancelled.add(projectId);
  return true;
}

export interface RunDTO {
  id: string;
  status: ProjectRun["status"];
  trigger: ProjectRun["trigger"];
  input: string | null;
  error: string | null;
  tokensUsed: number;
  /** The run went on with the tasks of the run before it, and kept the ones that had succeeded. */
  continued: boolean;
  hasDeliverable: boolean;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

/** A run as someone with this role is shown it: what went wrong names no provider to a user. */
export function serializeRun(run: ProjectRun, role: string | null | undefined): RunDTO {
  return {
    id: run.id,
    status: run.status,
    trigger: run.trigger,
    input: run.input,
    error: textFor(role, run.error),
    tokensUsed: run.tokensUsed,
    continued: run.continued,
    hasDeliverable: Boolean(run.deliverable),
    createdAt: run.createdAt.getTime(),
    startedAt: run.startedAt ? run.startedAt.getTime() : null,
    finishedAt: run.finishedAt ? run.finishedAt.getTime() : null,
  };
}

/** A project's runs, newest first. */
export function listRuns(projectId: string, limit = 20): ProjectRun[] {
  return db
    .select()
    .from(projectRuns)
    .where(eq(projectRuns.projectId, projectId))
    .orderBy(desc(projectRuns.createdAt), desc(projectRuns.id))
    .limit(Math.min(Math.max(1, limit), 100))
    .all();
}

export function loadRun(projectId: string, runId: string): ProjectRun | undefined {
  return db
    .select()
    .from(projectRuns)
    .where(and(eq(projectRuns.id, runId), eq(projectRuns.projectId, projectId)))
    .get();
}
