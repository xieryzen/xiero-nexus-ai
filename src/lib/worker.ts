import "server-only";
import { and, asc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db";
import { projectRuns, projectTasks, projects, type ProjectRun } from "@/db/schema";
import { recoverJobs, startDueJobs } from "./jobs";
import { RENDER_MAX_AGE_MS } from "./media/render";
import { failStaleRenders, refreshPendingVideos } from "./media/service";
import { deliverPendingWebhooks, notify } from "./notifications";
import { executeRun } from "./orchestrator";
import { publish } from "./run-bus";
import { runtime } from "./runtime";
import { runDueSchedules } from "./schedules";
import { stopOnSignal, stopping } from "./shutdown";

/**
 * The background worker: one loop per server process that does the work no
 * request waits for. Every few seconds it
 *
 *   - starts queued project runs, and picks up runs a restart interrupted,
 *   - starts the runs of schedules that are due,
 *   - asks providers about videos that are still being generated,
 *   - joins clips and embeds knowledge documents,
 *   - delivers notifications to webhooks.
 *
 * It starts with the server (src/instrumentation.ts) and needs nothing
 * besides the app itself: no second process, no queue service. NEXUS_WORKER=0
 * switches it off, for a second server process on the same database that
 * should only answer requests.
 */

const TICK_MS = 5_000;
/** A run whose process has not been heard of for this long is taken over. */
const HEARTBEAT_STALE_MS = 60_000;
/** Times a run is picked up again before it is given up on. */
const MAX_RESUMES = 3;
const HOUSEKEEPING_MS = 5 * 60_000;
/** How long a project may look busy without a run behind it before that is put right. */
const ORPHAN_AFTER_MS = 60_000;
const ORPHAN_CHECK_MS = 30_000;
let lastOrphanCheckAt = 0;
const INTERRUPTED_TASK = "The server stopped while this task was in progress.";

/** Project runs executed at the same time. RUN_CONCURRENCY changes it (1 to 10). */
export function runConcurrency(): number {
  const raw = Number(process.env.RUN_CONCURRENCY);
  return Number.isInteger(raw) && raw >= 1 && raw <= 10 ? raw : 3;
}

export function workerEnabled(): boolean {
  if (process.env.NEXUS_WORKER === "0" || process.env.NEXUS_WORKER === "false") return false;
  // `next build` loads the server code; nothing is to run then.
  return process.env.NEXT_PHASE !== "phase-production-build";
}

function launch(run: ProjectRun): void {
  const active = runtime().activeRuns;
  const work = executeRun(run.id)
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[xiero-nexus] run crashed:", err);
      endLostRun(run, "The run stopped unexpectedly. Check the server log.");
    })
    .finally(() => {
      active.delete(run.id);
      kickWorker();
    });
  active.set(run.id, work);
}

/** Tasks that were being worked on when their project stopped for good. */
function failInterruptedTasks(projectId: string): void {
  db.update(projectTasks)
    .set({ status: "failed", error: INTERRUPTED_TASK, updatedAt: new Date() })
    .where(and(eq(projectTasks.projectId, projectId), inArray(projectTasks.status, ["running", "ready"])))
    .run();
}

/** End a run that cannot go on, with its project, and say so. */
function endLostRun(run: ProjectRun, message: string): void {
  const now = new Date();
  const ended = db
    .update(projectRuns)
    .set({ status: "failed", error: message, finishedAt: now })
    .where(and(eq(projectRuns.id, run.id), inArray(projectRuns.status, ["queued", "running"])))
    .returning()
    .get();
  if (!ended) return;
  const project = db
    .update(projects)
    .set({ status: "failed", error: message, finishedAt: now, updatedAt: now })
    .where(eq(projects.id, run.projectId))
    .returning()
    .get();
  failInterruptedTasks(run.projectId);
  publish(run.projectId, { type: "status", status: "failed" });
  publish(run.projectId, { type: "error", message });
  publish(run.projectId, { type: "done", status: "failed" });
  if (project) {
    notify(project.createdBy, {
      kind: "run",
      level: "error",
      title: `Run failed: ${project.title}`,
      body: message,
      link: `/dashboard/projects/${project.id}`,
    });
  }
}

function heartbeat(): void {
  const ids = [...runtime().activeRuns.keys()];
  if (ids.length === 0) return;
  db.update(projectRuns)
    .set({ heartbeatAt: new Date() })
    .where(and(inArray(projectRuns.id, ids), eq(projectRuns.status, "running")))
    .run();
}

function startQueuedRuns(): void {
  const rt = runtime();
  let room = runConcurrency() - rt.activeRuns.size;
  if (room <= 0) return;
  const queued = db
    .select()
    .from(projectRuns)
    .where(eq(projectRuns.status, "queued"))
    .orderBy(asc(projectRuns.createdAt))
    .limit(room)
    .all();
  for (const candidate of queued) {
    if (room <= 0) break;
    const now = new Date();
    // Claimed in one statement, so two server processes never run the same run.
    const run = db
      .update(projectRuns)
      .set({ status: "running", workerId: rt.bootId, heartbeatAt: now, startedAt: now })
      .where(and(eq(projectRuns.id, candidate.id), eq(projectRuns.status, "queued")))
      .returning()
      .get();
    if (!run) continue;
    room--;
    launch(run);
  }
}

/** Runs that were in progress when their server process stopped. */
function resumeInterruptedRuns(): void {
  const rt = runtime();
  const stale = new Date(Date.now() - HEARTBEAT_STALE_MS);
  const lost = db
    .select()
    .from(projectRuns)
    .where(
      and(
        eq(projectRuns.status, "running"),
        or(isNull(projectRuns.heartbeatAt), lt(projectRuns.heartbeatAt, stale)),
      ),
    )
    .orderBy(asc(projectRuns.createdAt))
    .all()
    .filter((run) => !rt.activeRuns.has(run.id));

  for (const candidate of lost) {
    if (candidate.resumes >= MAX_RESUMES) {
      endLostRun(
        candidate,
        `The server stopped ${MAX_RESUMES + 1} times while this run was in progress, so it was given up on.`,
      );
      continue;
    }
    if (rt.activeRuns.size >= runConcurrency()) break;
    const now = new Date();
    const run = db
      .update(projectRuns)
      .set({ workerId: rt.bootId, heartbeatAt: now, resumes: candidate.resumes + 1 })
      .where(
        and(
          eq(projectRuns.id, candidate.id),
          eq(projectRuns.status, "running"),
          or(isNull(projectRuns.heartbeatAt), lt(projectRuns.heartbeatAt, stale)),
        ),
      )
      .returning()
      .get();
    if (!run) continue;
    // eslint-disable-next-line no-console
    console.log(`[xiero-nexus] picking up run ${run.id} again after a restart`);
    launch(run);
  }
}

/**
 * Projects that look busy with no run behind them. Versions before 1.5 ran a
 * project inside the request that started it: a server that stopped meanwhile
 * (for an upgrade, say) left the project "running" for good, with nothing
 * that would ever finish it. They are ended here, so that they can be run again.
 */
function releaseOrphanedProjects(): void {
  const startedAt = Date.now();
  if (startedAt - lastOrphanCheckAt < ORPHAN_CHECK_MS) return;
  lastOrphanCheckAt = startedAt;
  const busy = db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        inArray(projects.status, ["queued", "planning", "running"]),
        lt(projects.updatedAt, new Date(Date.now() - ORPHAN_AFTER_MS)),
      ),
    )
    .all();
  for (const { id } of busy) {
    const run = db
      .select({ id: projectRuns.id })
      .from(projectRuns)
      .where(and(eq(projectRuns.projectId, id), inArray(projectRuns.status, ["queued", "running"])))
      .get();
    if (run) continue;
    const now = new Date();
    const message = "The server stopped while this project was running. Run it again.";
    const ended = db
      .update(projects)
      .set({ status: "failed", error: message, finishedAt: now, updatedAt: now })
      .where(and(eq(projects.id, id), inArray(projects.status, ["queued", "planning", "running"])))
      .returning({ id: projects.id })
      .get();
    if (!ended) continue;
    failInterruptedTasks(id);
    publish(id, { type: "status", status: "failed" });
    publish(id, { type: "error", message });
    publish(id, { type: "done", status: "failed" });
  }
}

function housekeeping(): void {
  const w = runtime().worker;
  const now = Date.now();
  if (w.lastHousekeepingAt && now - w.lastHousekeepingAt < HOUSEKEEPING_MS) return;
  w.lastHousekeepingAt = now;
  recoverJobs();
  for (const asset of failStaleRenders(RENDER_MAX_AGE_MS)) {
    notify(asset.userId, {
      kind: "media",
      level: "error",
      title: "Joining the clips failed",
      body: asset.error ?? undefined,
      link: "/dashboard/studio",
    });
  }
  // Rate-limit windows that are over.
  const buckets = runtime().buckets;
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}

const STEPS: [string, () => void | Promise<unknown>][] = [
  ["heartbeat", heartbeat],
  ["runs", startQueuedRuns],
  ["resume", resumeInterruptedRuns],
  ["orphans", releaseOrphanedProjects],
  ["schedules", () => void runDueSchedules()],
  ["videos", () => refreshPendingVideos()],
  ["jobs", () => void startDueJobs()],
  ["webhooks", () => deliverPendingWebhooks()],
  ["housekeeping", housekeeping],
];

async function tick(): Promise<void> {
  const w = runtime().worker;
  // The server was told to stop: nothing new is started.
  if (stopping()) return;
  if (w.ticking) {
    w.again = true;
    return;
  }
  w.ticking = true;
  try {
    for (const [name, step] of STEPS) {
      try {
        await step();
        delete w.stepErrors[name];
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Logged when it starts failing, not on every round.
        if (w.stepErrors[name] !== message) {
          // eslint-disable-next-line no-console
          console.error(`[xiero-nexus] background worker, ${name}:`, err);
        }
        w.stepErrors[name] = message;
        w.lastError = `${name}: ${message}`;
      }
    }
  } finally {
    w.ticking = false;
    w.lastTickAt = Date.now();
    if (w.again) {
      w.again = false;
      setImmediate(() => void tick());
    }
  }
}

/** Start the worker of this server process. A second call does nothing. */
export function ensureWorker(): void {
  // With or without a worker, the server has to stop when it is told to.
  stopOnSignal();
  const w = runtime().worker;
  if (w.started || !workerEnabled()) return;
  w.started = true;
  w.startedAt = Date.now();
  w.timer = setInterval(() => void tick(), TICK_MS);
  // The worker must not keep a process alive that is otherwise done (a script, a test).
  w.timer.unref?.();
  const first = setTimeout(() => void tick(), 250);
  first.unref?.();
}

/** Do a round now instead of at the next interval: something was just queued. */
export function kickWorker(): void {
  ensureWorker();
  if (!runtime().worker.started) return;
  setImmediate(() => void tick());
}

export interface WorkerStatus {
  enabled: boolean;
  started: boolean;
  lastTickAt: number | null;
  activeRuns: number;
  runConcurrency: number;
  problems: string[];
}

export function workerStatus(): WorkerStatus {
  const rt = runtime();
  return {
    enabled: workerEnabled(),
    started: rt.worker.started,
    lastTickAt: rt.worker.lastTickAt,
    activeRuns: rt.activeRuns.size,
    runConcurrency: runConcurrency(),
    problems: Object.entries(rt.worker.stepErrors).map(([step, message]) => `${step}: ${message}`),
  };
}
