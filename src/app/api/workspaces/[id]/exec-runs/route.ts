import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { listExecRuns, loadOwnedWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req, { params }) => {
  const user = requireUser();
  const ws = loadOwnedWorkspace(params.id!, user);
  return json({ runs: listExecRuns(ws.id, 20) });
});
