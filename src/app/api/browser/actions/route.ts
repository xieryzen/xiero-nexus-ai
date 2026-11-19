import { handle, json } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { listActions } from "@/lib/browser/accounts";

export const dynamic = "force-dynamic";

/**
 * What was done in the browser, newest first: for an owner everything, for
 * an administrator what was done for their own projects.
 */
export const GET = handle(async (req) => {
  const user = requireAdmin();
  const params = new URL(req.url).searchParams;
  const limit = Number(params.get("limit") ?? 60);
  const before = Number(params.get("before") ?? 0);
  return json({
    actions: listActions({
      ...(user.role === "owner" ? {} : { userId: user.id }),
      limit: Number.isFinite(limit) ? limit : 60,
      ...(Number.isFinite(before) && before > 0 ? { before } : {}),
    }),
  });
});
