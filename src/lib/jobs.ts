import "server-only";
import { and, asc, eq, inArray, isNull, lt, lte, or } from "drizzle-orm";
import { db } from "@/db";
import { jobs, knowledgeDocuments, type Job } from "@/db/schema";
import { AppError } from "./errors";
import { embedDocument } from "./knowledge/service";
import { renderAsset } from "./media/render";
import { notify } from "./notifications";
import { runtime } from "./runtime";

/**
 * Work the background worker does outside a project run: joining clips with
 * ffmpeg, and embedding the passages of a knowledge document.
 */

type JobKind = Job["kind"];

/** Jobs of each kind that run at the same time. ffmpeg takes a whole CPU. */
const CONCURRENCY: Record<JobKind, number> = { render: 1, embed: 2 };
const MAX_ATTEMPTS: Record<JobKind, number> = { render: 1, embed: 3 };
/** A job another process took and never finished is taken back after this long. */
const LOCK_STALE_MS: Record<JobKind, number> = { render: 70 * 60_000, embed: 15 * 60_000 };
const KEEP_FINISHED_MS = 7 * 24 * 60 * 60_000;

function payloadOf(job: Job): Record<string, unknown> {
  try {
    const value = JSON.parse(job.payload) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function runRender(job: Job): Promise<void> {
  const assetId = payloadOf(job).assetId;
  if (typeof assetId !== "string") throw new AppError(400, "bad_job", "The job names no asset");
  const asset = await renderAsset(assetId);
  if (asset.source !== "render") return;
  if (asset.status === "ready") {
    notify(asset.userId, {
      kind: "media",
      level: asset.error ? "warning" : "success",
      title: "Your joined video is ready",
      problem: asset.error,
      body: asset.error ? undefined : asset.prompt,
      link: "/dashboard/studio",
    });
  } else if (asset.status === "failed") {
    notify(asset.userId, {
      kind: "media",
      level: "error",
      title: "Joining the clips failed",
      problem: asset.error,
      link: "/dashboard/studio",
    });
  }
}

async function runEmbed(job: Job): Promise<void> {
  const documentId = payloadOf(job).documentId;
  if (typeof documentId !== "string") throw new AppError(400, "bad_job", "The job names no document");
  await embedDocument(documentId, job.userId);
}

const HANDLERS: Record<JobKind, (job: Job) => Promise<void>> = { render: runRender, embed: runEmbed };

function finish(job: Job, error: string | null): void {
  const now = new Date();
  const attempts = job.attempts + 1;
  if (error === null) {
    db.update(jobs)
      .set({ status: "done", error: null, attempts, finishedAt: now, updatedAt: now })
      .where(eq(jobs.id, job.id))
      .run();
    return;
  }
  if (attempts < MAX_ATTEMPTS[job.kind]) {
    // Try again later: half a minute, then two minutes.
    db.update(jobs)
      .set({
        status: "queued",
        error,
        attempts,
        workerId: null,
        lockedAt: null,
        runAfter: new Date(now.getTime() + (attempts === 1 ? 30_000 : 120_000)),
        updatedAt: now,
      })
      .where(eq(jobs.id, job.id))
      .run();
    return;
  }
  db.update(jobs)
    .set({ status: "failed", error, attempts, finishedAt: now, updatedAt: now })
    .where(eq(jobs.id, job.id))
    .run();
  if (job.kind === "embed") {
    const documentId = payloadOf(job).documentId;
    const doc =
      typeof documentId === "string"
        ? db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, documentId)).get()
        : undefined;
    if (doc) {
      notify(job.userId, {
        kind: "knowledge",
        level: "error",
        title: `Could not embed "${doc.title}"`,
        problem: error,
        body: "The document can still be searched by its words.",
        link: `/dashboard/knowledge?collection=${doc.collectionId}`,
      });
    }
  }
}

/** Start the queued jobs there is room for. Does not wait for them to finish. */
export function startDueJobs(): number {
  const rt = runtime();
  const running = rt.worker.jobs;
  const now = new Date();
  let started = 0;

  for (const kind of Object.keys(CONCURRENCY) as JobKind[]) {
    const active = db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.kind, kind), eq(jobs.status, "running"), eq(jobs.workerId, rt.bootId)))
      .all()
      .filter((j) => running.has(j.id)).length;
    let room = CONCURRENCY[kind] - active;
    if (room <= 0) continue;
    const due = db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.kind, kind),
          eq(jobs.status, "queued"),
          or(isNull(jobs.runAfter), lte(jobs.runAfter, now)),
        ),
      )
      .orderBy(asc(jobs.createdAt))
      .limit(room)
      .all();
    for (const candidate of due) {
      if (room <= 0) break;
      // Claimed in one statement, so two server processes never take the same job.
      const job = db
        .update(jobs)
        .set({ status: "running", workerId: rt.bootId, lockedAt: now, updatedAt: now })
        .where(and(eq(jobs.id, candidate.id), eq(jobs.status, "queued")))
        .returning()
        .get();
      if (!job) continue;
      room--;
      started++;
      running.add(job.id);
      void HANDLERS[job.kind](job)
        .then(
          () => finish(job, null),
          (err: unknown) => {
            if (!(err instanceof AppError)) {
              // eslint-disable-next-line no-console
              console.error(`[xiero-nexus] ${job.kind} job failed:`, err);
            }
            finish(job, err instanceof AppError ? err.message : "The job failed unexpectedly.");
          },
        )
        .catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.error("[xiero-nexus] could not record a job's result:", err);
        })
        .finally(() => running.delete(job.id));
    }
  }
  return started;
}

/**
 * Take back jobs that were in progress when a server process stopped, and
 * forget finished jobs after a week.
 */
export function recoverJobs(): void {
  const rt = runtime();
  const now = Date.now();
  const stuck = db
    .select()
    .from(jobs)
    .where(eq(jobs.status, "running"))
    .all()
    .filter((job) => {
      if (rt.worker.jobs.has(job.id)) return false;
      // This process's own job that is no longer being worked on is lost for sure.
      if (job.workerId === rt.bootId) return true;
      return !job.lockedAt || now - job.lockedAt.getTime() > LOCK_STALE_MS[job.kind];
    });
  for (const job of stuck) finish(job, "The server stopped while this was in progress.");

  db.delete(jobs)
    .where(
      and(
        inArray(jobs.status, ["done", "failed"]),
        lt(jobs.updatedAt, new Date(now - KEEP_FINISHED_MS)),
      ),
    )
    .run();
}
