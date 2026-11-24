import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { loadOwnedProject } from "@/lib/project-access";
import { projectResult } from "@/lib/result";

export const dynamic = "force-dynamic";

/**
 * What the project made: its files, the web site among them, what was built
 * from them, and where all of it is downloaded.
 */
export const GET = handle(async (_req, { params }) => {
  const user = requireUser();
  const project = loadOwnedProject(params.id!, user);
  return json({ result: projectResult(project) });
});
