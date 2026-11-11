import { redirect } from "next/navigation";
import { getSessionState } from "@/lib/auth";
import { RegisterForm } from "@/components/auth/register-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Create account" };

export default function RegisterPage() {
  const state = getSessionState();
  if (state.status === "active") redirect("/dashboard");
  if (state.status === "pending") redirect("/login/2fa");
  return <RegisterForm />;
}
