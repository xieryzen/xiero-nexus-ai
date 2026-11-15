/**
 * Runs once when the server starts. It starts the background worker, so that
 * queued runs, schedules and videos move forward from the moment the server
 * is up, before the first request arrives.
 */
export async function register(): Promise<void> {
  // The worker needs Node.js (the database, ffmpeg). This file is also built
  // for the Edge runtime, where there is nothing to start; the import has to
  // sit inside this condition so that the Edge build leaves it out.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startBackgroundWork } = await import("./instrumentation-node");
    startBackgroundWork();
  }
}
