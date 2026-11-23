import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { liveFor } from "@/lib/browser/sessions";

export const dynamic = "force-dynamic";

/**
 * The pages that wait for this person: of their own runs and conversations,
 * and for an owner of everyone's. Any account asks: a user's assistant signs
 * in with what the user handed over, and a page of it can wait for them.
 */
export const GET = handle(async () => {
  const user = requireUser();
  return json({ waiting: liveFor(user) });
});
