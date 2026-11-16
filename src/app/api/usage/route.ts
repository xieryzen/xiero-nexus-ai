import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getUsageSummary } from "@/lib/stats";
import { isAdminRole } from "@/lib/roles";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const user = requireUser();
  // Admins see platform-wide usage; others see only their own.
  const scope = isAdminRole(user.role) ? null : user.id;
  return json({ summary: getUsageSummary(scope), scope: isAdminRole(user.role) ? "all" : "self" });
});
