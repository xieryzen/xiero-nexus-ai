import { notFound, redirect } from "next/navigation";
import { and, eq, isNotNull, or } from "drizzle-orm";
import { db } from "@/db";
import { agents, models, projects, users } from "@/db/schema";
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
import { mayUseServer } from "@/lib/ssh/rules";
import { operatorsOf, serversFor, serversOfProject } from "@/lib/ssh/servers";

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

  // The servers the project may be given: the ones this account may use and
  // the account the project belongs to may use as well. And whether this
  // account may run and change the project at all: only when its own projects
  // may work on every server this one names (ssh/servers.ts).
  const owner = project.createdBy ? db.select({ role: users.role }).from(users).where(eq(users.id, project.createdBy)).get() : undefined;
  const serverOptions = serversFor(user)
    .filter((s) => mayUseServer(owner?.role, s.access))
    .map((s) => ({ id: s.id, label: s.name, where: `${s.username}@${s.host}:${s.port}`, off: s.status !== "enabled" }));
  const mayOperate = serversOfProject(project.id).every((s) => mayUseServer(user.role, s.access));
  // Which of its agents can run commands there: without one, naming a server reaches nothing.
  const operators = serverOptions.length > 0 ? operatorsOf(project) : [];

  return (
    <ProjectRunner
      project={projectFor(user.role, serializeProject(project, { withTasks: true }))}
      serverOptions={serverOptions}
      serverOperators={operators}
      mayOperate={mayOperate}
      chooses={sees}
      agentNames={agentNames}
      canRun={canRun && mayOperate}
      canApprove={isAdminRole(user.role) && mayOperate}
      initialAssets={assetsForProject(project.id).map((a) => assetFor(user.role, serializeAsset(a)))}
      imageModelLabel={modelLabel(asRun.imageModelRowId)}
      videoModelLabel={modelLabel(asRun.videoModelRowId)}
      speechModelLabel={modelLabel(asRun.speechModelRowId)}
      initialSchedules={listSchedules(project.id).map(serializeSchedule)}
      initialRuns={listRuns(project.id, 30).map((run) => serializeRun(run, user.role))}
    />
  );
}
