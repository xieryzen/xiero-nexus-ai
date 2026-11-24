import "server-only";
import { and, asc, count, eq, isNotNull, lte } from "drizzle-orm";
import { db } from "@/db";
import { projects, schedules, users, type Project, type Schedule } from "@/db/schema";
import { describeCron, isValidTimeZone, nextRun, nextRuns, scheduleProblem } from "./cron";
import { AppError, Errors } from "./errors";
import { MAX_RUN_INPUT_CHARS, startRun } from "./runs";
import { hasFeatureFor } from "./plans";

/**
 * Schedules: a project that runs by itself, at the times a cron expression
 * names in a time zone. The background worker starts the runs.
 */

export const MAX_SCHEDULES_PER_PROJECT = 5;
/**
 * A scheduled time that passed while the server was not running is still
 * started when the server is back within this long. After that it is skipped.
 */
const LATE_START_GRACE_MS = 15 * 60_000;

export interface ScheduleDTO {
  id: string;
  cron: string;
  timezone: string;
  /** The schedule in words, such as "Every day at 08:00". */
  description: string;
  enabled: boolean;
  input: string | null;
  nextRunAt: number | null;
  /** The next few times, for showing what the expression means. */
  upcoming: number[];
  lastRunAt: number | null;
  lastStatus: Schedule["lastStatus"];
  lastError: string | null;
}

export function serializeSchedule(s: Schedule): ScheduleDTO {
  let upcoming: number[] = [];
  let description = s.cron;
  try {
    description = describeCron(s.cron);
    if (s.enabled) upcoming = nextRuns(s.cron, new Date(), s.timezone, 3).map((d) => d.getTime());
  } catch {
    /* an expression stored by an older version that no longer parses */
  }
  return {
    id: s.id,
    cron: s.cron,
    timezone: s.timezone,
    description,
    enabled: s.enabled,
    input: s.input,
    nextRunAt: s.enabled && s.nextRunAt ? s.nextRunAt.getTime() : null,
    upcoming,
    lastRunAt: s.lastRunAt ? s.lastRunAt.getTime() : null,
    lastStatus: s.lastStatus,
    lastError: s.lastError,
  };
}

export function listSchedules(projectId: string): Schedule[] {
  return db
    .select()
    .from(schedules)
    .where(eq(schedules.projectId, projectId))
    .orderBy(asc(schedules.createdAt))
    .all();
}

export interface ScheduleInput {
  cron: string;
  timezone: string;
  input?: string | null;
  enabled?: boolean;
}

function check(cron: string, timezone: string): void {
  if (!isValidTimeZone(timezone)) throw Errors.badRequest(`"${timezone}" is not a time zone`);
  const problem = scheduleProblem(cron, timezone);
  if (problem) throw Errors.badRequest(problem);
}

function normalizeCron(cron: string): string {
  return cron.trim().replace(/\s+/g, " ");
}

export function createSchedule(project: Project, userId: string, input: ScheduleInput): Schedule {
  const cron = normalizeCron(input.cron);
  check(cron, input.timezone);
  const existing = db
    .select({ n: count() })
    .from(schedules)
    .where(eq(schedules.projectId, project.id))
    .get();
  if ((existing?.n ?? 0) >= MAX_SCHEDULES_PER_PROJECT) {
    throw Errors.badRequest(`A project can have ${MAX_SCHEDULES_PER_PROJECT} schedules`);
  }
  const enabled = input.enabled ?? true;
  return db
    .insert(schedules)
    .values({
      projectId: project.id,
      cron,
      timezone: input.timezone,
      enabled,
      input: input.input?.trim() ? input.input.trim().slice(0, MAX_RUN_INPUT_CHARS) : null,
      nextRunAt: enabled ? nextRun(cron, new Date(), input.timezone) : null,
      createdBy: userId,
    })
    .returning()
    .get();
}

export function loadSchedule(projectId: string, scheduleId: string): Schedule {
  const schedule = db
    .select()
    .from(schedules)
    .where(and(eq(schedules.id, scheduleId), eq(schedules.projectId, projectId)))
    .get();
  if (!schedule) throw Errors.notFound("Schedule not found");
  return schedule;
}

export function updateSchedule(schedule: Schedule, input: Partial<ScheduleInput>): Schedule {
  const cron = input.cron !== undefined ? normalizeCron(input.cron) : schedule.cron;
  const timezone = input.timezone ?? schedule.timezone;
  const enabled = input.enabled ?? schedule.enabled;
  if (input.cron !== undefined || input.timezone !== undefined) check(cron, timezone);
  return db
    .update(schedules)
    .set({
      cron,
      timezone,
      enabled,
      ...(input.input !== undefined
        ? { input: input.input?.trim() ? input.input.trim().slice(0, MAX_RUN_INPUT_CHARS) : null }
        : {}),
      // Counted from now: a schedule that is switched on again does not fire
      // for the times it missed while it was off.
      nextRunAt: enabled ? nextRun(cron, new Date(), timezone) : null,
      updatedAt: new Date(),
    })
    .where(eq(schedules.id, schedule.id))
    .returning()
    .get();
}

export function deleteSchedule(schedule: Schedule): void {
  db.delete(schedules).where(eq(schedules.id, schedule.id)).run();
}

/** Start the runs of the schedules that are due. Called by the background worker. */
export function runDueSchedules(now: Date = new Date()): number {
  const due = db
    .select()
    .from(schedules)
    .where(and(eq(schedules.enabled, true), isNotNull(schedules.nextRunAt), lte(schedules.nextRunAt, now)))
    .orderBy(asc(schedules.nextRunAt))
    .limit(20)
    .all();
  let started = 0;

  for (const schedule of due) {
    const dueAt = schedule.nextRunAt ?? now;
    let next: Date | null = null;
    try {
      next = nextRun(schedule.cron, now, schedule.timezone);
    } catch {
      next = null;
    }
    const set = (values: Partial<Schedule>) =>
      db
        .update(schedules)
        .set({ nextRunAt: next, updatedAt: new Date(), ...values })
        .where(eq(schedules.id, schedule.id))
        .run();
    // The next time is stored before anything is started, so that a problem
    // below cannot make the same time fire again and again.
    if (!next) {
      set({ enabled: false, lastStatus: "error", lastError: "The schedule no longer names a time. It was switched off." });
      continue;
    }
    if (now.getTime() - dueAt.getTime() > LATE_START_GRACE_MS) {
      set({ lastStatus: "skipped", lastError: "The server was not running at the scheduled time." });
      continue;
    }

    const project = db.select().from(projects).where(eq(projects.id, schedule.projectId)).get();
    if (!project) {
      set({ lastStatus: "error", lastError: "The project no longer exists." });
      continue;
    }
    const owner = project.createdBy
      ? db.select({ status: users.status }).from(users).where(eq(users.id, project.createdBy)).get()
      : undefined;
    if (!owner || owner.status !== "active") {
      set({ lastStatus: "error", lastError: "The project's owner cannot sign in, so it is not run." });
      continue;
    }
    // The plan of the account may have changed since the schedule was made.
    if (!hasFeatureFor(project.createdBy, "automation")) {
      set({ lastStatus: "skipped", lastError: "Schedules are not part of the plan of the project's account any more." });
      continue;
    }

    try {
      const result = startRun(project, {
        trigger: "schedule",
        scheduleId: schedule.id,
        requestedBy: project.createdBy,
        input: schedule.input,
      });
      if (result.outcome === "queued") {
        started++;
        set({ lastRunAt: now, lastRunId: result.run.id, lastStatus: "started", lastError: null });
      } else if (result.outcome === "needs_approval") {
        set({ lastRunAt: now, lastRunId: result.run.id, lastStatus: "skipped", lastError: "The project is waiting for an approval." });
      } else {
        set({ lastRunAt: now, lastRunId: result.run.id, lastStatus: "error", lastError: result.message ?? "The run could not start." });
      }
    } catch (err) {
      const busy = err instanceof AppError && err.code === "run_active";
      set({
        lastStatus: busy ? "skipped" : "error",
        lastError: busy
          ? "The run before it was still in progress."
          : err instanceof AppError
            ? err.message
            : "The run could not start.",
      });
      if (!busy && !(err instanceof AppError)) {
        // eslint-disable-next-line no-console
        console.error("[xiero-nexus] schedule failed:", err);
      }
    }
  }
  return started;
}
