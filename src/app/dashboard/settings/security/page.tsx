import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { SecurityClient } from "@/components/account/security-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Security" };

export default function SecurityPage() {
  const user = getCurrentUser()!;
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Security" description="Two-factor authentication for your account." />
      <div className="mb-4">
        <Link href="/dashboard/settings" className="text-sm text-ink-3 hover:text-ink">
          ← Back to settings
        </Link>
      </div>
      <SecurityClient initialEnabled={user.twoFactorEnabled} />
    </div>
  );
}
