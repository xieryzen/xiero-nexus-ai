import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getUsageSummary } from "@/lib/stats";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const user = requireUser();
  // Admins see platform-wide usage; others see only their own.
  const scope = user.role === "admin" ? null : user.id;
  return json({ summary: getUsageSummary(scope), scope: user.role === "admin" ? "all" : "self" });
});
