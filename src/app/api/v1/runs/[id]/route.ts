import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { projectRuns } from "@/db/schema";
import { Errors } from "@/lib/errors";
import { loadOwnedProject } from "@/lib/project-access";
import { runJson } from "@/lib/public-api/runs";
import { v1 } from "@/lib/public-api/server";

export const dynamic = "force-dynamic";

/** A run: its state, and what it delivered once it has finished. */
export const GET = v1("projects", (_req, { params, caller }) => {
  const run = db.select().from(projectRuns).where(eq(projectRuns.id, params.id!)).get();
  if (!run) throw Errors.notFound("Run not found");
  try {
    loadOwnedProject(run.projectId, caller.user);
  } catch {
    // Someone else's run looks the same as one that does not exist.
    throw Errors.notFound("Run not found");
  }
  return NextResponse.json(runJson(run, { detail: true }));
});
