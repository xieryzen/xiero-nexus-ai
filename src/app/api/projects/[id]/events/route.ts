import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { loadOwnedProject } from "@/lib/project-access";
import { SSE_HEADERS, runEventStream } from "@/lib/run-bus";

export const dynamic = "force-dynamic";

/**
 * Follow a project's run: its state so far, then what happens, as server-sent
 * events, until the run ends. When nothing is running the state is sent and
 * the stream ends at once.
 */
export const GET = handle(async (req, { params }) => {
  const user = requireUser();
  const project = loadOwnedProject(params.id!, user);
  return new Response(runEventStream(project.id, req.signal, user.role), { headers: SSE_HEADERS });
});
