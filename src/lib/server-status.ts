import "server-only";
import { and, count, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { jobs, mediaAssets, notifications, projectRuns, schedules } from "@/db/schema";
import { toolStatus } from "./agent/tools";
import { ffmpegStatus } from "./media/ffmpeg";
import { agentAllowedHosts } from "./web-fetch";
import { workerStatus } from "./worker";

/**
 * What this server is set up for and what its background worker is doing.
 * For the administrator's status page: no secrets, only whether things are
 * configured and how much is waiting.
 */
export interface ServerStatus {
  worker: {
    enabled: boolean;
    started: boolean;
    /** Milliseconds since its last round, or null when it has not run yet. */
    lastRoundAgoMs: number | null;
    activeRuns: number;
    runConcurrency: number;
    problems: string[];
  };
  queue: {
    runsQueued: number;
    runsRunning: number;
    videosPending: number;
    rendersPending: number;
    jobsQueued: number;
    jobsFailed: number;
    webhooksPending: number;
    schedulesEnabled: number;
  };
  ffmpeg: { available: boolean; version: string | null; h264: boolean; subtitles: boolean };
  tools: { sandbox: boolean; search: string | null; hostsRestricted: boolean };
}

function n(row: { n: number } | undefined): number {
  return row?.n ?? 0;
}

export async function serverStatus(): Promise<ServerStatus> {
  const worker = workerStatus();
  const ffmpeg = await ffmpegStatus();
  const tools = toolStatus();
  const runs = (status: "queued" | "running") =>
    n(db.select({ n: count() }).from(projectRuns).where(eq(projectRuns.status, status)).get());
  const pendingMedia = (source: "provider" | "render") =>
    n(
      db
        .select({ n: count() })
        .from(mediaAssets)
        .where(and(eq(mediaAssets.status, "pending"), eq(mediaAssets.source, source)))
        .get(),
    );
  return {
    worker: {
      enabled: worker.enabled,
      started: worker.started,
      lastRoundAgoMs: worker.lastTickAt ? Date.now() - worker.lastTickAt : null,
      activeRuns: worker.activeRuns,
      runConcurrency: worker.runConcurrency,
      problems: worker.problems,
    },
    queue: {
      runsQueued: runs("queued"),
      runsRunning: runs("running"),
      videosPending: pendingMedia("provider"),
      rendersPending: pendingMedia("render"),
      jobsQueued: n(db.select({ n: count() }).from(jobs).where(inArray(jobs.status, ["queued", "running"])).get()),
      jobsFailed: n(db.select({ n: count() }).from(jobs).where(eq(jobs.status, "failed")).get()),
      webhooksPending: n(
        db.select({ n: count() }).from(notifications).where(eq(notifications.webhookStatus, "pending")).get(),
      ),
      schedulesEnabled: n(db.select({ n: count() }).from(schedules).where(eq(schedules.enabled, true)).get()),
    },
    ffmpeg: { available: ffmpeg.available, version: ffmpeg.version, h264: ffmpeg.h264, subtitles: ffmpeg.subtitles },
    tools: { sandbox: tools.sandbox, search: tools.search, hostsRestricted: agentAllowedHosts().length > 0 },
  };
}
