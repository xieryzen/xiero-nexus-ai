import { redirect } from "next/navigation";
import { getSessionState } from "@/lib/auth";
import { TwoFactorForm } from "@/components/auth/two-factor-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Two-factor verification" };

export default function TwoFactorPage() {
  const state = getSessionState();
  if (state.status === "none") redirect("/login");
  if (state.status === "active") redirect("/dashboard");
  return <TwoFactorForm />;
}
