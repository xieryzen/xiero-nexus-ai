import "server-only";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  agents,
  mediaAssets,
  projectRuns,
  projects,
  projectTasks,
  type ProjectRun,
} from "@/db/schema";
import { eventFor } from "./for-viewer";
import { serializeAsset, type MediaAssetDTO } from "./media/dto";
import type { RunEvent } from "./orchestrator/events";
import { runtime, type RunChannel } from "./runtime";
import { tokensLeftFor } from "./tokens";

/**
 * What a project run reports, and how pages follow it.
 *
 * A run is executed by the background worker, not by the request that started
 * it. The worker publishes the run's events here; a page that follows the run
 * first gets the state as it is in the database and then the events as they
 * happen. That way a page can attach at any time: after a reload, from a
 * second browser, or after the server was restarted.
 */

function channels(): Map<string, RunChannel<RunEvent>> {
  return runtime().channels as Map<string, RunChannel<RunEvent>>;
}

/** Send an event to every page that follows this project's run. */
export function publish(projectId: string, event: RunEvent): void {
  const channel = channels().get(projectId);
  if (!channel) return;
  for (const listener of [...channel.listeners]) {
    try {
      listener(event);
    } catch {
      /* a page that went away */
    }
  }
}

/** Follow a project's run. Returns the function that stops following. */
export function subscribe(projectId: string, listener: (event: RunEvent) => void): () => void {
  const all = channels();
  let channel = all.get(projectId);
  if (!channel) {
    channel = { listeners: new Set() };
    all.set(projectId, channel);
  }
  channel.listeners.add(listener);
  return () => {
    channel.listeners.delete(listener);
    if (channel.listeners.size === 0 && all.get(projectId) === channel) all.delete(projectId);
  };
}

/** The run of a project that is waiting or in progress, if there is one. */
export function activeRun(projectId: string): ProjectRun | undefined {
  return db
    .select()
    .from(projectRuns)
    .where(and(eq(projectRuns.projectId, projectId), inArray(projectRuns.status, ["queued", "running"])))
    .orderBy(desc(projectRuns.createdAt))
    .get();
}

/**
 * A project's state as the events that would have led to it: its status, the
 * plan, every task that has started, and the result when there is one.
 */
export function snapshotEvents(projectId: string): RunEvent[] {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) return [];
  const events: RunEvent[] = [{ type: "status", status: project.status }];
  const tasks = db
    .select()
    .from(projectTasks)
    .where(eq(projectTasks.projectId, projectId))
    .orderBy(asc(projectTasks.seq))
    .all();
  if (tasks.length > 0) {
    const names = new Map(
      db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .all()
        .map((a) => [a.id, a.name] as const),
    );
    const assets = new Map<string, MediaAssetDTO[]>();
    for (const asset of db.select().from(mediaAssets).where(eq(mediaAssets.projectId, projectId)).all()) {
      if (!asset.taskId) continue;
      const list = assets.get(asset.taskId) ?? [];
      list.push(serializeAsset(asset));
      assets.set(asset.taskId, list);
    }
    const agentOf = (id: string | null) => (id ? (names.get(id) ?? null) : null);
    const dependsOn = (raw: string | null): number[] => {
      try {
        const value = JSON.parse(raw ?? "[]") as unknown;
        return Array.isArray(value) ? value.filter((n): n is number => typeof n === "number") : [];
      } catch {
        return [];
      }
    };
    events.push({
      type: "plan",
      tasks: tasks.map((t) => ({
        id: t.id,
        seq: t.seq,
        title: t.title,
        agent: agentOf(t.agentId) ?? "",
        dependsOn: dependsOn(t.dependsOn),
        kind: t.kind,
      })),
    });
    // Every task, the ones that wait to start among them: a run that continues
    // an earlier one keeps its tasks, and a page that showed one of them as
    // failed has to be told that it waits once more.
    for (const t of tasks) {
      events.push({
        type: "task",
        seq: t.seq,
        title: t.title,
        status: t.status,
        agent: agentOf(t.agentId),
        artifact: t.artifact,
        error: t.error,
        tokens: (t.promptTokens ?? 0) + (t.completionTokens ?? 0),
        assets: assets.get(t.id),
        steps: t.steps || undefined,
        toolCalls: t.toolCallCount || undefined,
      });
    }
    events.push({ type: "tokens", used: project.tokensUsed, left: tokensLeftFor(project.createdBy) });
  }
  if (project.finalDeliverable) events.push({ type: "final", deliverable: project.finalDeliverable });
  if (project.reviewNotes) events.push({ type: "review", notes: project.reviewNotes });
  if (project.status === "failed" && project.error) events.push({ type: "error", message: project.error });
  return events;
}

/**
 * A project's run as a stream of server-sent events: the state so far, then
 * what happens, until the run ends. Closing the stream does not stop the run.
 */
export function runEventStream(
  projectId: string,
  signal: AbortSignal | undefined,
  /** The role of who follows: decides what of the setup the events say (for-viewer.ts). */
  role: string | null | undefined,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let stop: () => void = () => undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe: () => void = () => undefined;
      let timer: ReturnType<typeof setInterval> | null = null;
      const write = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          stop();
        }
      };
      const send = (event: RunEvent) => write(`data: ${JSON.stringify(eventFor(role, event))}\n\n`);
      stop = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (timer) clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const sendStateAndEnd = () => {
        const events = snapshotEvents(projectId);
        for (const event of events) send(event);
        const status = events.find((e): e is Extract<RunEvent, { type: "status" }> => e.type === "status");
        send({ type: "done", status: status?.status ?? "failed" });
        stop();
      };

      // The state and the subscription are taken in one go, with nothing
      // awaited in between, so no event is missed and none comes twice.
      if (!activeRun(projectId)) {
        sendStateAndEnd();
        return;
      }
      for (const event of snapshotEvents(projectId)) send(event);
      unsubscribe = subscribe(projectId, (event) => {
        send(event);
        if (event.type === "done") stop();
      });
      // Keeps the connection open through proxies during long waits, and ends
      // the stream if the run ended without this process hearing of it.
      timer = setInterval(() => {
        if (activeRun(projectId)) write(": waiting\n\n");
        else sendStateAndEnd();
      }, 10_000);
      signal?.addEventListener("abort", () => stop(), { once: true });
    },
    cancel() {
      stop();
    },
  });
}

export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  "x-accel-buffering": "no",
} as const;
