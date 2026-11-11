import { redirect } from "next/navigation";
import { getSessionState } from "@/lib/auth";
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
  return (
    <AppShell user={{ username: user.username, email: user.email, role: user.role }}>
      {children}
    </AppShell>
  );
}
