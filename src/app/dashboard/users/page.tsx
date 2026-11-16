import { redirect } from "next/navigation";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { publicUser, requirePageUser } from "@/lib/auth";
import { isAdminRole, isOwnerRole } from "@/lib/roles";
import { defaultTokenLimit } from "@/lib/token-rules";
import { PageHeader } from "@/components/ui";
import { UsersManager } from "@/components/users/users-manager";

export const dynamic = "force-dynamic";
export const metadata = { title: "Users & Roles" };

export default function UsersPage() {
  const current = requirePageUser();
  if (!isAdminRole(current.role)) redirect("/dashboard");
  const owner = isOwnerRole(current.role);

  const rows = db.select().from(users).orderBy(desc(users.createdAt)).all();

  return (
    <div>
      <PageHeader
        title="Users & Roles"
        description={
          owner
            ? "The accounts of this installation: who they are, what they may do, how they sign in, and how many tokens each may use. Every change is in the audit log."
            : "The accounts of this installation. Roles and status are enforced on the server."
        }
      />
      <UsersManager
        initialUsers={rows.map(publicUser)}
        currentUserId={current.id}
        canManage={owner}
        defaultTokenLimit={defaultTokenLimit()}
      />
    </div>
  );
}
