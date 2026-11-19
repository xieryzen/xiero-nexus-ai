import { handle, json } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { liveFor } from "@/lib/browser/sessions";

export const dynamic = "force-dynamic";

/** The pages that wait for this person: of their own runs, and for an owner of everyone's. */
export const GET = handle(async () => {
  const user = requireAdmin();
  return json({ waiting: liveFor(user) });
});
