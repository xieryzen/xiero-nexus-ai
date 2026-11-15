import "server-only";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { mediaAssets, projectRuns, projectTasks, type ProjectRun } from "@/db/schema";
import { mediaJson, unixSeconds } from "./server";

/** A run as the public API shows it. */
export function runJson(run: ProjectRun, opts: { detail?: boolean } = {}) {
  const base = {
    id: run.id,
    object: "run" as const,
    project_id: run.projectId,
    // queued, running, succeeded, review (finished, but not everything
    // succeeded), needs_approval, failed, cancelled.
    status: run.status,
    trigger: run.trigger,
    input: run.input,
    error: run.error,
    tokens_used: run.tokensUsed,
    created_at: unixSeconds(run.createdAt),
    started_at: unixSeconds(run.startedAt),
    finished_at: unixSeconds(run.finishedAt),
  };
  if (!opts.detail) return base;

  // The tasks belong to the project's latest run: an earlier run keeps what
  // it delivered, but not its tasks.
  const latest = db
    .select({ id: projectRuns.id })
    .from(projectRuns)
    .where(eq(projectRuns.projectId, run.projectId))
    .orderBy(asc(projectRuns.createdAt))
    .all()
    .pop();
  let tasks: unknown[] | null = null;
  if (latest?.id === run.id) {
    const assets = db.select().from(mediaAssets).where(eq(mediaAssets.projectId, run.projectId)).all();
    tasks = db
      .select()
      .from(projectTasks)
      .where(eq(projectTasks.projectId, run.projectId))
      .orderBy(asc(projectTasks.seq))
      .all()
      .map((t) => ({
        seq: t.seq,
        title: t.title,
        kind: t.kind,
        status: t.status,
        error: t.error,
        output: t.artifact,
        media: assets.filter((a) => a.taskId === t.id).map(mediaJson),
      }));
  }
  return { ...base, deliverable: run.deliverable, review_notes: run.reviewNotes, tasks };
}
