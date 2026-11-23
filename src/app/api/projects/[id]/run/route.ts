import { takeAccessForProject } from "@/lib/access/store";
import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { Errors } from "@/lib/errors";
import { loadOperableProject } from "@/lib/project-access";
import { getClientMeta } from "@/lib/request";
import { SSE_HEADERS, runEventStream } from "@/lib/run-bus";
import { startRun } from "@/lib/runs";
import { runStartSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * Start a run and follow it. The answer is a stream of server-sent events, as
 * before, but the run itself is executed by the background worker: closing
 * the connection does not stop it, and GET …/events follows it again.
 *
 * The body is optional: { "input": "an extra instruction for this run",
 * "continue": true }. With `continue` the run goes on with the tasks of the
 * last run: the ones that succeeded are kept, the others are done again.
 * 409 when the project is already running, or when there is nothing to
 * continue.
 */
export const POST = handle(async (req, { params }) => {
  const user = requireUser();
  const project = loadOperableProject(params.id!, user); // throws if not owner/admin, or not allowed on its servers

  let input: string | undefined;
  let continueLast = false;
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
    continueLast = parsed.data.continue === true;
  }

  // What signs in is taken out of the instruction before the run is stored (src/lib/access).
  if (input) input = (await takeAccessForProject(user, project, input, getClientMeta(req))).text;

  startRun(project, { trigger: "manual", requestedBy: user.id, input, continueLast });
  return new Response(runEventStream(project.id, req.signal, user.role), { headers: SSE_HEADERS });
});
