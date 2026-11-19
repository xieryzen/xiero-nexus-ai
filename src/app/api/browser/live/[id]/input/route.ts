import { handle, json, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { liveInput } from "@/lib/browser/sessions";
import { AppError, Errors } from "@/lib/errors";
import { rateLimit } from "@/lib/ratelimit";
import { liveInputSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** What a person did to the page they took over: a click, a key, a text, a turn of the wheel. */
export const POST = handle(async (req, { params }) => {
  const user = requireAdmin();
  const rate = rateLimit(`browser-input:${user.id}`, 600, 60_000);
  if (!rate.ok) throw Errors.rateLimited("Too much at once. Try again in a moment.");
  const body = await parseBody(req, liveInputSchema);
  const outcome = await liveInput(params.id!, user, body);
  if (outcome === "gone") throw Errors.notFound("This page does not wait any more: it was handed back, or its time was up.");
  if (outcome === "busy") throw new AppError(409, "busy", "The app is still filling in the form. Wait a moment.");
  if (outcome === "invalid") throw Errors.badRequest("That cannot be passed on to the page.");
  return json({ ok: true });
});
