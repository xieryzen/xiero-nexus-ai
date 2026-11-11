import { notFound, redirect } from "next/navigation";
import { and, eq, isNotNull, or } from "drizzle-orm";
import { db } from "@/db";
import { agents, models, projects, providers } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { adapterIsImplemented } from "@/lib/adapters";
import { serializeProject } from "@/lib/workforce";
import { ProjectRunner } from "@/components/projects/project-runner";

export const dynamic = "force-dynamic";
export const metadata = { title: "Project" };

export default function ProjectDetailPage({ params }: { params: { id: string } }) {
  const user = getCurrentUser()!;
  const project = db.select().from(projects).where(eq(projects.id, params.id)).get();
  if (!project) notFound();
  if (project.createdBy !== user.id && user.role !== "admin") redirect("/dashboard/projects");

  const agentRows = db.select({ id: agents.id, name: agents.name }).from(agents).all();
  const agentNames: Record<string, string> = {};
  for (const a of agentRows) agentNames[a.id] = a.name;

  // canRun: at least one usable model AND at least one active agent that has a model
  const usableModels = db
    .select({ adapter: providers.adapter })
    .from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(and(eq(models.enabled, true), eq(providers.status, "enabled")))
    .all()
    .some((m) => adapterIsImplemented(m.adapter));

  const agentsWithModel = db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.status, "active"), or(isNotNull(agents.primaryModelRowId), isNotNull(agents.fallbackModelRowId))))
    .all().length;

  const canRun = usableModels && agentsWithModel > 0;

  return (
    <ProjectRunner
      project={serializeProject(project, { withTasks: true })}
      agentNames={agentNames}
      canRun={canRun}
      canApprove={user.role === "admin"}
    />
  );
}
