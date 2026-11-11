import { redirect } from "next/navigation";
import { getSessionState } from "@/lib/auth";
import { insecureTransportNotice } from "@/lib/session";
import { RegisterForm } from "@/components/auth/register-form";
import { TransportNotice } from "@/components/auth/transport-notice";

export const dynamic = "force-dynamic";
export const metadata = { title: "Create account" };

export default function RegisterPage() {
  const state = getSessionState();
  if (state.status === "active") redirect("/dashboard");
  if (state.status === "pending") redirect("/login/2fa");
  const notice = insecureTransportNotice();
  return (
    <>
      <TransportNotice message={notice} />
      <RegisterForm blocked={notice !== null} />
    </>
  );
}
