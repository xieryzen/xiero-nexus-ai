import { redirect } from "next/navigation";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getCurrentUser, publicUser } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { UsersManager } from "@/components/users/users-manager";

export const dynamic = "force-dynamic";
export const metadata = { title: "Users & Roles" };

export default function UsersPage() {
  const current = getCurrentUser();
  if (current?.role !== "admin") redirect("/dashboard");

  const rows = db.select().from(users).orderBy(desc(users.createdAt)).all();

  return (
    <div>
      <PageHeader title="Users & Roles" description="Manage access. Roles and status are enforced server-side." />
      <UsersManager initialUsers={rows.map(publicUser)} currentUserId={current.id} />
    </div>
  );
}
