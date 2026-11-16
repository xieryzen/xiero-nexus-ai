import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { Errors } from "@/lib/errors";
import { loadOwnedProject } from "@/lib/project-access";
import { SSE_HEADERS, runEventStream } from "@/lib/run-bus";
import { startRun } from "@/lib/runs";
import { runStartSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * Start a run and follow it. The answer is a stream of server-sent events, as
 * before, but the run itself is executed by the background worker: closing
 * the connection does not stop it, and GET …/events follows it again.
 *
 * The body is optional: { "input": "an extra instruction for this run" }.
 * 409 when the project is already running.
 */
export const POST = handle(async (req, { params }) => {
  const user = requireUser();
  const project = loadOwnedProject(params.id!, user); // throws if not owner/admin

  let input: string | undefined;
  const raw = await req.text().catch(() => "");
  if (raw.trim()) {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw Errors.badRequest("Request body must be valid JSON");
    }
    const parsed = runStartSchema.safeParse(body);
    if (!parsed.success) {
      throw Errors.badRequest(parsed.error.issues[0]?.message ?? "Invalid request");
    }
    input = parsed.data.input;
  }

  startRun(project, { trigger: "manual", requestedBy: user.id, input });
  return new Response(runEventStream(project.id, req.signal, user.role), { headers: SSE_HEADERS });
});
