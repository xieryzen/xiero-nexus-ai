import { notFound, redirect } from "next/navigation";
import { and, eq, isNotNull, or } from "drizzle-orm";
import { db } from "@/db";
import { agents, models, projects } from "@/db/schema";
import { requirePageUser } from "@/lib/auth";
import { serializeAsset } from "@/lib/media/dto";
import { assetsForProject } from "@/lib/media/service";
import { chatModels } from "@/lib/model-options";
import { listRuns, serializeRun } from "@/lib/runs";
import { listSchedules, serializeSchedule } from "@/lib/schedules";
import { serializeProject } from "@/lib/workforce";
import { ProjectRunner } from "@/components/projects/project-runner";
import { isAdminRole, seesSetup } from "@/lib/roles";
import { assetFor, projectFor } from "@/lib/for-viewer";
import { kindsAvailable, withRunModels } from "@/lib/model-choice";

export const dynamic = "force-dynamic";
export const metadata = { title: "Project" };

export default function ProjectDetailPage({ params }: { params: { id: string } }) {
  const user = requirePageUser();
  const project = db.select().from(projects).where(eq(projects.id, params.id)).get();
  if (!project) notFound();
  if (project.createdBy !== user.id && !isAdminRole(user.role)) redirect("/dashboard/projects");

  const agentRows = db.select({ id: agents.id, name: agents.name }).from(agents).all();
  const agentNames: Record<string, string> = {};
  for (const a of agentRows) agentNames[a.id] = a.name;

  // Someone who is shown the setup sees the project with its models. A user
  // sees their work without them (for-viewer.ts).
  const sees = seesSetup(user.role);

  // canRun: at least one model that can chat AND at least one active agent that has a model
  const usableModels = sees ? chatModels().length > 0 : kindsAvailable().chat;

  const agentsWithModel = db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.status, "active"), or(isNotNull(agents.primaryModelRowId), isNotNull(agents.fallbackModelRowId))))
    .all().length;

  const canRun = usableModels && agentsWithModel > 0;

  // The models its creative tasks generate with, by name. For a user: only
  // that the project makes that kind, by what a run would work with.
  const asRun = sees ? project : withRunModels(project);
  const modelLabel = (id: string | null): string | null => {
    if (!id) return null;
    if (!sees) return "yes";
    const m = db.select({ modelId: models.modelId, displayName: models.displayName }).from(models).where(eq(models.id, id)).get();
    return m ? m.displayName || m.modelId : null;
  };

  return (
    <ProjectRunner
      project={projectFor(user.role, serializeProject(project, { withTasks: true }))}
      chooses={sees}
      agentNames={agentNames}
      canRun={canRun}
      canApprove={isAdminRole(user.role)}
      initialAssets={assetsForProject(project.id).map((a) => assetFor(user.role, serializeAsset(a)))}
      imageModelLabel={modelLabel(asRun.imageModelRowId)}
      videoModelLabel={modelLabel(asRun.videoModelRowId)}
      speechModelLabel={modelLabel(asRun.speechModelRowId)}
      initialSchedules={listSchedules(project.id).map(serializeSchedule)}
      initialRuns={listRuns(project.id, 30).map((run) => serializeRun(run, user.role))}
    />
  );
}
