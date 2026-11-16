import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { loadOwnedProject } from "@/lib/project-access";
import { listRuns, serializeRun } from "@/lib/runs";

export const dynamic = "force-dynamic";

/** A project's runs, newest first. */
export const GET = handle(async (_req, { params }) => {
  const user = requireUser();
  const project = loadOwnedProject(params.id!, user);
  return json({ runs: listRuns(project.id, 30).map((run) => serializeRun(run, user.role)) });
});
