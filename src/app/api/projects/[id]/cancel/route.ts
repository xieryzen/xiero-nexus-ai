import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { loadOwnedProject } from "@/lib/project-access";
import { requestCancel } from "@/lib/orchestrator";

export const dynamic = "force-dynamic";

export const POST = handle(async (_req, { params }) => {
  const user = requireUser();
  const project = loadOwnedProject(params.id!, user);
  requestCancel(project.id);
  return json({ ok: true });
});
