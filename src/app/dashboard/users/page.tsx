import { redirect } from "next/navigation";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { publicUser, requirePageUser } from "@/lib/auth";
import { getPlanSettings } from "@/lib/plans";
import { TIERS, isAdminRole, isOwnerRole, type Tier } from "@/lib/roles";
import { PageHeader } from "@/components/ui";
import { UsersManager } from "@/components/users/users-manager";

export const dynamic = "force-dynamic";
export const metadata = { title: "Users & Roles" };

export default function UsersPage() {
  const current = requirePageUser();
  if (!isAdminRole(current.role)) redirect("/dashboard");
  const owner = isOwnerRole(current.role);

  const rows = db.select().from(users).orderBy(desc(users.createdAt)).all();
  const settings = getPlanSettings();
  const allowances = Object.fromEntries(TIERS.map((tier) => [tier, settings.plans[tier].monthlyTokens])) as Record<Tier, number | null>;

  return (
    <div>
      <PageHeader
        title="Users & Roles"
        description={
          owner
            ? "The accounts of this installation: who they are, which role each has, how they sign in, and how many tokens each may use in a month. Every change is in the audit log."
            : "The accounts of this installation. Roles and status are enforced on the server."
        }
      />
      <UsersManager
        initialUsers={rows.map(publicUser)}
        currentUserId={current.id}
        canManage={owner}
        allowances={allowances}
      />
    </div>
  );
}
