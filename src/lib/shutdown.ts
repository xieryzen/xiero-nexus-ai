import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { projectRuns } from "@/db/schema";
import { runtime } from "./runtime";

/**
 * Stopping the server.
 *
 * Next.js answers SIGINT and SIGTERM by closing its HTTP server, and exits
 * once the last open connection has ended. A page that follows a run, or a
 * chat answer that is still being written, keeps a connection open for
 * minutes. Until then the process stays, and whoever asked it to stop loses
 * patience and kills it: Docker after 10 seconds, Pterodactyl after 10
 * minutes, with "Stop" in its panel looking stuck all that time.
 *
 * So, when the server is told to stop:
 *
 *   - no new background work is started,
 *   - requests in progress get a few seconds to finish,
 *   - then the process exits, whatever is still open,
 *   - and the runs it was working on are handed back, so that the next start
 *     picks them up at once instead of a minute later.
 *
 * A second signal ends the process immediately.
 */

/** What requests in progress get to finish in. */
export const STOP_GRACE_MS = 3_000;

/** Whether this process was told to stop. */
export function stopping(): boolean {
  return runtime().stop.asked;
}

/**
 * Runs this process is executing go back to "nobody has them": a server that
 * starts next takes a run without a heartbeat over at once.
 */
function handBackRuns(): void {
  const rt = runtime();
  if (rt.activeRuns.size === 0) return;
  try {
    db.update(projectRuns)
      .set({ heartbeatAt: null })
      .where(and(eq(projectRuns.workerId, rt.bootId), eq(projectRuns.status, "running")))
      .run();
  } catch {
    // The database cannot be written any more. The runs are still picked up
    // again: when their heartbeat has gone stale.
  }
}

/** Listen for the signals that stop the server. A second call does nothing. */
export function stopOnSignal(): void {
  // Only in the server itself: not while building, and not in a script or a
  // test that happens to open the database.
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const rt = runtime();
  if (rt.stop.listening) return;
  rt.stop.listening = true;

  const begin = (signal: string) => {
    if (rt.stop.asked) process.exit(0);
    rt.stop.asked = true;
    const w = rt.worker;
    if (w.timer) clearInterval(w.timer);
    w.timer = null;
    const runs = rt.activeRuns.size;
    // eslint-disable-next-line no-console
    console.log(
      `[xiero-nexus] ${signal}: stopping.` +
        (runs > 0 ? ` ${runs} run${runs === 1 ? "" : "s"} in progress will be picked up again at the next start.` : ""),
    );
    setTimeout(() => process.exit(0), STOP_GRACE_MS);
  };
  process.on("SIGINT", () => begin("SIGINT"));
  process.on("SIGTERM", () => begin("SIGTERM"));
  process.on("exit", handBackRuns);
}
