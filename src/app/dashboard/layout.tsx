import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionState } from "@/lib/auth";
import { tierOf } from "@/lib/roles";
import { tokensOf } from "@/lib/tokens";
import { AppShell } from "@/components/shell/app-shell";

export const dynamic = "force-dynamic";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const state = getSessionState();
  if (state.status === "none") redirect("/login");
  if (state.status === "pending") redirect("/login/2fa");

  const { user } = state;
  const tokens = tokensOf(user);
  return (
    <AppShell
      user={{
        username: user.username,
        email: user.email,
        role: user.role,
        tier: tierOf(user),
        tokens: { limit: tokens.limit, used: tokens.used, left: tokens.left, renewsAt: tokens.renewsAt },
      }}
      // The sidebar as the reader left it: folded away or open.
      collapsed={cookies().get("nexus-sidebar")?.value === "closed"}
    >
      {children}
    </AppShell>
  );
}
