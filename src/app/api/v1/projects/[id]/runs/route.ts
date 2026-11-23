import { NextResponse } from "next/server";
import { takeAccessForProject } from "@/lib/access/store";
import { getClientMeta } from "@/lib/request";
import { loadOperableProject, loadOwnedProject } from "@/lib/project-access";
import { RequestError } from "@/lib/public-api/openai-format";
import { runJson } from "@/lib/public-api/runs";
import { readOptionalJsonBody, v1 } from "@/lib/public-api/server";
import { MAX_RUN_INPUT_CHARS, listRuns, startRun } from "@/lib/runs";

export const dynamic = "force-dynamic";

/** A project's runs, newest first. */
export const GET = v1("projects", (_req, { params, caller }) => {
  const project = loadOwnedProject(params.id!, caller.user);
  return NextResponse.json({ object: "list", data: listRuns(project.id, 50).map((r) => runJson(r, caller.user.role)) });
});

/**
 * Start a run of a project. The body is optional: { "input": "an extra
 * instruction for this run", "continue": true }. With `continue` the run
 * goes on with the tasks of the last run: the ones that succeeded are kept
 * with their output, the others are done again. Answers at once: 202 with
 * the run `queued`; GET /api/v1/runs/{id} says how it went. 409 when the
 * project is already running, or when there is nothing to continue. A run
 * that cannot start is answered with 200 and its status (`failed`, with the
 * reason, or `needs_approval`).
 */
export const POST = v1("projects", async (req, { params, caller }) => {
  const project = loadOperableProject(params.id!, caller.user);
  let input: string | undefined;
  let continueLast = false;
  const body = await readOptionalJsonBody(req);
  if (body !== undefined) {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new RequestError("The request body must be a JSON object");
    }
    const value = (body as { input?: unknown }).input;
    if (value !== undefined && value !== null) {
      if (typeof value !== "string") throw new RequestError("input must be a string", "input");
      if (value.length > MAX_RUN_INPUT_CHARS) {
        throw new RequestError(`input can be at most ${MAX_RUN_INPUT_CHARS} characters`, "input");
      }
      input = value;
    }
    const goOn = (body as { continue?: unknown }).continue;
    if (goOn !== undefined && goOn !== null) {
      if (typeof goOn !== "boolean") throw new RequestError("continue must be true or false", "continue");
      continueLast = goOn;
    }
  }
  // What signs in is taken out of the instruction before the run is stored
  // (src/lib/access); the answer says what became of it.
  const taken = input ? await takeAccessForProject(caller.user, project, input, getClientMeta(req)) : null;
  if (taken) input = taken.text;
  const result = startRun(project, {
    trigger: "api",
    requestedBy: caller.user.id,
    apiKeyId: caller.key.id,
    input,
    continueLast,
  });
  return NextResponse.json(
    {
      ...runJson(result.run, caller.user.role),
      message: result.message ?? null,
      // Only when the instruction held a sign-in or a key: what was kept under which name, and what was not and why.
      ...(taken && taken.kept.length > 0
        ? { access_kept: taken.kept.map((k) => ({ kind: k.kind, name: k.name || null, where: k.where, kept: k.ok, replaced: k.updated, note: k.note })) }
        : {}),
    },
    { status: result.outcome === "queued" ? 202 : 200 },
  );
});
