import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { models, projects, providers, teams, workflows } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { adapterIsImplemented } from "@/lib/adapters";
import { serializeProject } from "@/lib/workforce";
import { CommandCenter } from "@/components/projects/command-center";

export const dynamic = "force-dynamic";
export const metadata = { title: "AI Manager" };

export default function ProjectsPage() {
  const user = getCurrentUser()!;

  const projectRows =
    user.role === "admin"
      ? db.select().from(projects).orderBy(desc(projects.updatedAt)).all()
      : db.select().from(projects).where(eq(projects.createdBy, user.id)).orderBy(desc(projects.updatedAt)).all();

  const modelRows = db
    .select({ id: models.id, modelId: models.modelId, displayName: models.displayName, providerName: providers.name, adapter: providers.adapter })
    .from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(and(eq(models.enabled, true), eq(providers.status, "enabled")))
    .orderBy(asc(models.modelId))
    .all();

  const managerModels = modelRows
    .filter((m) => adapterIsImplemented(m.adapter))
    .map((m) => ({ id: m.id, label: `${m.displayName || m.modelId} · ${m.providerName}` }));

  const teamRows = db.select({ id: teams.id, name: teams.name }).from(teams).orderBy(asc(teams.name)).all();
  const workflowRows = db.select({ id: workflows.id, name: workflows.name }).from(workflows).orderBy(asc(workflows.name)).all();

  return (
    <CommandCenter
      initialProjects={projectRows.map((p) => serializeProject(p))}
      managerModels={managerModels}
      teams={teamRows.map((t) => ({ id: t.id, label: t.name }))}
      workflows={workflowRows.map((w) => ({ id: w.id, label: w.name }))}
    />
  );
}
