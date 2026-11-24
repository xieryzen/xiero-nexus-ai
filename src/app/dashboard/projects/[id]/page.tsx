import { ownForRun } from "@/lib/access/for-run";
import { siteOfKey } from "@/lib/access/rules";
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
import { tokensLeftFor } from "@/lib/tokens";
import { notInPlan } from "@/lib/plan-rules";
import { getPlanSettings, hasFeatureFor } from "@/lib/plans";
import { serializeProject } from "@/lib/workforce";
import { projectResult } from "@/lib/result";
import { ProjectRunner } from "@/components/projects/project-runner";
import { isAdminRole, seesSetup, tierOf } from "@/lib/roles";
import { assetFor, projectFor } from "@/lib/for-viewer";
import { kindsAvailable, withRunModels } from "@/lib/model-choice";
import { accountsFor, accountsOfProject, browsersOf } from "@/lib/browser/accounts";
import { mayUseAccount, siteHost } from "@/lib/browser/rules";
import { browserConfigured } from "@/lib/browser/service";
import { mayUseServer } from "@/lib/ssh/rules";
import { operatorsOf, serversFor, serversOfProject } from "@/lib/ssh/servers";

export const dynamic = "force-dynamic";
export const metadata = { title: "Project" };

/** What the project's account handed over itself and the goal is about: what a run would work with, as things are now. */
function handedTo(project: { createdBy: string | null; title: string; goal: string }) {
  const own = ownForRun(project.createdBy, `${project.title}\n${project.goal}`);
  return [
    ...own.servers.map((s) => ({ kind: "server" as const, name: s.name, where: `${s.username}@${s.host}` })),
    ...own.accounts.map((a) => ({ kind: "site" as const, name: a.name, where: `${a.username} on ${siteHost(a.siteUrl)}` })),
    ...own.keys.map((k) => ({ kind: "key" as const, name: k.name, where: siteOfKey(k.site) ? `${k.label}, for ${siteOfKey(k.site)}` : k.label })),
  ];
}

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

  // What its creative tasks are made with, as a run would work: the models
  // the project names, and the app's choice for a kind it names none for
  // (model-choice.ts). By name for those who are shown the setup; for a user
  // only that the project makes that kind.
  const asRun = withRunModels(project);
  const modelLabel = (id: string | null, named: string | null): string | null => {
    if (!id) return null;
    if (!sees) return "yes";
    const m = db.select({ modelId: models.modelId, displayName: models.displayName }).from(models).where(eq(models.id, id)).get();
    if (!m) return null;
    return `${m.displayName || m.modelId}${named ? "" : " (the app's choice)"}`;
  };

  // The servers the project may be given: the ones this account may use and
  // the account the project belongs to may use as well. And whether this
  // account may run and change the project at all: only when its own projects
  // may work on every server this one names (ssh/servers.ts).
  const owner = project.createdBy ? db.select({ role: users.role }).from(users).where(eq(users.id, project.createdBy)).get() : undefined;
  const serverOptions = serversFor(user)
    .filter((s) => mayUseServer(owner?.role, s.access))
    .map((s) => ({ id: s.id, label: s.name, where: `${s.username}@${s.host}:${s.port}`, off: s.status !== "enabled" }));
  // The same for the site accounts its agents sign in with.
  const accountOptions = accountsFor(user)
    .filter((a) => mayUseAccount(owner?.role, a.access))
    .map((a) => ({ id: a.id, label: a.name, where: `${a.username} on ${siteHost(a.siteUrl)}`, site: siteHost(a.siteUrl), off: a.status !== "enabled" }));
  const mayOperate =
    serversOfProject(project.id).every((s) => mayUseServer(user.role, s.access)) &&
    accountsOfProject(project.id).every((a) => mayUseAccount(user.role, a.access));
  // Which of its agents can run commands there: without one, naming a server reaches nothing.
  const operators = serverOptions.length > 0 ? operatorsOf(project) : [];

  return (
    <ProjectRunner
      project={projectFor(user.role, serializeProject(project, { withTasks: true }))}
      serverOptions={serverOptions}
      serverOperators={operators}
      accountOptions={accountOptions}
      // Which of its agents can work in a browser: without one, naming an account signs nobody in.
      accountAgents={accountOptions.length > 0 ? browsersOf(project) : []}
      browserReady={browserConfigured()}
      mayOperate={mayOperate}
      // What a run of it is held to: the tokens its account has left, and no budget of the project.
      tokensLeft={tokensLeftFor(project.createdBy)}
      own={project.createdBy === user.id}
      handed={project.createdBy === user.id ? handedTo(project) : []}
      chooses={sees}
      agentNames={agentNames}
      canRun={canRun && mayOperate}
      canApprove={isAdminRole(user.role) && mayOperate}
      initialAssets={assetsForProject(project.id).map((a) => assetFor(user.role, serializeAsset(a)))}
      initialResult={projectResult(project)}
      imageModelLabel={modelLabel(asRun.imageModelRowId, project.imageModelRowId)}
      videoModelLabel={modelLabel(asRun.videoModelRowId, project.videoModelRowId)}
      speechModelLabel={modelLabel(asRun.speechModelRowId, project.speechModelRowId)}
      initialSchedules={listSchedules(project.id).map(serializeSchedule)}
      // Schedules are a feature of a plan (v2.0): the plan of the account the project belongs to.
      schedulesNotInPlan={
        hasFeatureFor(project.createdBy, "automation")
          ? null
          : project.createdBy === user.id
            ? notInPlan(getPlanSettings(), tierOf(user), "automation")
            : "Schedules are not part of the plan of the account this project belongs to."
      }
      initialRuns={listRuns(project.id, 30).map((run) => serializeRun(run, user.role))}
    />
  );
}
