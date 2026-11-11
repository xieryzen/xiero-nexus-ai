import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { loadOwnedProject } from "@/lib/project-access";
import { ensureWorkspace, listFiles } from "@/lib/workspace";
import { getExecutor } from "@/lib/workspace/executor";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req, { params }) => {
  const user = requireUser();
  const project = loadOwnedProject(params.id!, user);
  const ws = ensureWorkspace(project.id, user.id);
  const executor = getExecutor();
  return json({
    workspace: { id: ws.id, name: ws.name },
    files: listFiles(ws.id),
    execution: { enabled: executor.enabled, allowedCommands: executor.allowedCommands },
  });
});
