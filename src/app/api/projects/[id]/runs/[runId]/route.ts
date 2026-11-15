import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { Errors } from "@/lib/errors";
import { loadOwnedProject } from "@/lib/project-access";
import { loadRun, serializeRun } from "@/lib/runs";

export const dynamic = "force-dynamic";

/** One run, with what it delivered. */
export const GET = handle(async (_req, { params }) => {
  const user = requireUser();
  const project = loadOwnedProject(params.id!, user);
  const run = loadRun(project.id, params.runId!);
  if (!run) throw Errors.notFound("Run not found");
  return json({
    run: { ...serializeRun(run), deliverable: run.deliverable, reviewNotes: run.reviewNotes },
  });
});
