import { redirect } from "next/navigation";
import { getSessionState } from "@/lib/auth";
import { insecureTransportNotice } from "@/lib/session";
import { LoginForm } from "@/components/auth/login-form";
import { TransportNotice } from "@/components/auth/transport-notice";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

export default function LoginPage() {
  const state = getSessionState();
  if (state.status === "active") redirect("/dashboard");
  if (state.status === "pending") redirect("/login/2fa");
  const notice = insecureTransportNotice();
  return (
    <>
      <TransportNotice message={notice} />
      <LoginForm blocked={notice !== null} />
    </>
  );
}
