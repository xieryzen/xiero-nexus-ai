import { handle, json, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { liveOf, liveSettle } from "@/lib/browser/sessions";
import { Errors } from "@/lib/errors";
import { liveSettleSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

const GONE = "This page does not wait any more: it was handed back, or its time was up.";

/** A page that waits for a person: what it waits for, and until when. */
export const GET = handle(async (_req, { params }) => {
  const user = requireAdmin();
  const live = liveOf(params.id!, user);
  if (!live) throw Errors.notFound(GONE);
  return json({ live });
});

/**
 * What becomes of the page. For a page of a run: "continue" hands it back to
 * the agent, "give_up" tells the agent that it cannot be done. For a sign-in
 * an owner does by hand: "save" keeps the session, "discard" drops it.
 */
export const POST = handle(async (req, { params }) => {
  const user = requireAdmin();
  const body = await parseBody(req, liveSettleSchema);
  const live = liveOf(params.id!, user);
  if (!live) throw Errors.notFound(GONE);
  if (!liveSettle(params.id!, user, body.outcome)) {
    throw Errors.badRequest(live.kind === "run" ? 'A page of a run is handed back ("continue") or given up ("give_up").' : 'A sign-in by hand is kept ("save") or dropped ("discard").');
  }
  return json({ ok: true });
});
