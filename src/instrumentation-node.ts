import { openDatabase } from "@/db";

/** Open the database, which applies the migrations and starts the background worker. */
export function startBackgroundWork(): void {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  try {
    openDatabase();
  } catch (err) {
    // The server still starts: the first request reports the problem properly.
    // eslint-disable-next-line no-console
    console.error("[xiero-nexus] could not start the background worker at boot:", err);
  }
}
