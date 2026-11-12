import { notFound, redirect } from "next/navigation";
import { and, eq, isNotNull, or } from "drizzle-orm";
import { db } from "@/db";
import { agents, models, projects } from "@/db/schema";
import { requirePageUser } from "@/lib/auth";
import { serializeAsset } from "@/lib/media/dto";
import { assetsForProject } from "@/lib/media/service";
import { chatModels } from "@/lib/model-options";
import { serializeProject } from "@/lib/workforce";
import { ProjectRunner } from "@/components/projects/project-runner";

export const dynamic = "force-dynamic";
export const metadata = { title: "Project" };

export default function ProjectDetailPage({ params }: { params: { id: string } }) {
  const user = requirePageUser();
  const project = db.select().from(projects).where(eq(projects.id, params.id)).get();
  if (!project) notFound();
  if (project.createdBy !== user.id && user.role !== "admin") redirect("/dashboard/projects");

  const agentRows = db.select({ id: agents.id, name: agents.name }).from(agents).all();
  const agentNames: Record<string, string> = {};
  for (const a of agentRows) agentNames[a.id] = a.name;

  // canRun: at least one model that can chat AND at least one active agent that has a model
  const usableModels = chatModels().length > 0;

  const agentsWithModel = db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.status, "active"), or(isNotNull(agents.primaryModelRowId), isNotNull(agents.fallbackModelRowId))))
    .all().length;

  const canRun = usableModels && agentsWithModel > 0;

  // The models its image / video tasks generate with, by name.
  const modelLabel = (id: string | null): string | null => {
    if (!id) return null;
    const m = db.select({ modelId: models.modelId, displayName: models.displayName }).from(models).where(eq(models.id, id)).get();
    return m ? m.displayName || m.modelId : null;
  };

  return (
    <ProjectRunner
      project={serializeProject(project, { withTasks: true })}
      agentNames={agentNames}
      canRun={canRun}
      canApprove={user.role === "admin"}
      initialAssets={assetsForProject(project.id).map((a) => serializeAsset(a))}
      imageModelLabel={modelLabel(project.imageModelRowId)}
      videoModelLabel={modelLabel(project.videoModelRowId)}
    />
  );
}
