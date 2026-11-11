import { asc } from "drizzle-orm";
import { db } from "@/db";
import { workflows } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { serializeWorkflow } from "@/lib/workforce";
import { WorkflowsManager } from "@/components/workflows/workflows-manager";

export const dynamic = "force-dynamic";
export const metadata = { title: "Workflows" };

export default function WorkflowsPage() {
  const user = getCurrentUser();
  const rows = db.select().from(workflows).orderBy(asc(workflows.name)).all();
  return <WorkflowsManager initialWorkflows={rows.map(serializeWorkflow)} isAdmin={user?.role === "admin"} />;
}
