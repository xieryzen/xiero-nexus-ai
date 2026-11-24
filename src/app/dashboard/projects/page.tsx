import { asc, desc, eq } from "drizzle-orm";
import { standInsEnabled } from "@/lib/model-choice-rules";
import { db } from "@/db";
import { projects, teams, workflows } from "@/db/schema";
import { requirePageUser } from "@/lib/auth";
import { ffmpegStatus } from "@/lib/media/ffmpeg";
import { projectFor } from "@/lib/for-viewer";
import { autoMedia, kindsAvailable } from "@/lib/model-choice";
import { chatModels, mediaModelOptions, usableModels } from "@/lib/model-options";
import { countMediaTasks } from "@/lib/orchestrator/plan";
import { serializeProject, serializeWorkflow } from "@/lib/workforce";
import { CommandCenter } from "@/components/projects/command-center";
import { PlanNotice } from "@/components/plan-notice";
import { hasFeature } from "@/lib/plan-rules";
import { getPlanSettings } from "@/lib/plans";
import { isAdminRole, seesSetup, tierLabel, tierOf } from "@/lib/roles";
import { accountsFor } from "@/lib/browser/accounts";
import { siteHost } from "@/lib/browser/rules";
import { serversFor } from "@/lib/ssh/servers";

export const dynamic = "force-dynamic";
export const metadata = { title: "Projects" };

export default async function ProjectsPage() {
  const user = requirePageUser();

  const projectRows =
    isAdminRole(user.role)
      ? db.select().from(projects).orderBy(desc(projects.updatedAt)).all()
      : db.select().from(projects).where(eq(projects.createdBy, user.id)).orderBy(desc(projects.updatedAt)).all();

  // Someone who is shown the setup chooses the project's models. A user is
  // not handed the lists: the app chooses, and the form is told only what the
  // installation can do, as one entry ("yes") per kind.
  const chooses = seesSetup(user.role);
  // A kind of media the plan of the account does not have is not offered.
  const settings = getPlanSettings();
  const tier = tierOf(user);
  const inPlan = { image: hasFeature(settings, tier, "studio_image"), video: hasFeature(settings, tier, "studio_video"), audio: hasFeature(settings, tier, "studio_voice") };
  const lacking = [inPlan.image ? "" : "Images", inPlan.video ? "" : "Videos", inPlan.audio ? "" : "Voice-overs"].filter(Boolean);
  const mediaNotInPlan =
    lacking.length === 0
      ? null
      : `${lacking.length === 1 ? lacking[0] : `${lacking.slice(0, -1).join(", ")} and ${lacking[lacking.length - 1]!.toLowerCase()}`} are not in the ${tierLabel(tier)} plan.`;
  const available = chooses ? null : kindsAvailable(tier);
  const can = available ? { ...available, image: available.image && inPlan.image, video: available.video && inPlan.video, audio: available.audio && inPlan.audio } : null;
  const yes = (available: boolean) => (available ? [{ id: "auto", label: "Yes" }] : []);
  const allModels = chooses ? usableModels() : [];
  const managerModels = can
    ? yes(can.chat)
    : chatModels(allModels).map((m) => ({
        id: m.id,
        label: `${m.name} · ${m.providerName}`,
      }));
  const imageModels = can ? yes(can.image) : mediaModelOptions("image", allModels).map((m) => ({ id: m.id, label: m.label }));
  const videoModels = can ? yes(can.video) : mediaModelOptions("video", allModels).map((m) => ({ id: m.id, label: m.label }));
  const speechModels = can ? yes(can.audio) : mediaModelOptions("audio", allModels).map((m) => ({ id: m.id, label: m.label }));
  const ffmpeg = await ffmpegStatus();

  const teamRows = db.select({ id: teams.id, name: teams.name }).from(teams).orderBy(asc(teams.name)).all();
  // What each workflow generates and how many steps it has, so the form can
  // ask for the models and the room it needs before the project is created.
  const workflowOptions = db
    .select()
    .from(workflows)
    .orderBy(asc(workflows.name))
    .all()
    .map((w) => {
      const steps = serializeWorkflow(w).steps;
      return {
        id: w.id,
        label: w.name,
        media: countMediaTasks(steps.map((step) => ({ kind: step.kind ?? "text" }))),
        steps: steps.length,
      };
    });

  return (
    <>
      <PlanNotice account={user} feature="projects" />
      <CommandCenter
      initialProjects={projectRows.map((p) => projectFor(user.role, serializeProject(p)))}
      chooses={chooses}
      standInsDefault={standInsEnabled(process.env.MODEL_STAND_INS)}
      managerModels={managerModels}
      imageModels={imageModels}
      videoModels={videoModels}
      speechModels={speechModels}
      autoMedia={autoMedia()}
      mediaNotInPlan={mediaNotInPlan}
      canRender={ffmpeg.available && ffmpeg.h264}
      teams={teamRows.map((t) => ({ id: t.id, label: t.name }))}
      workflows={workflowOptions}
      // The machines the projects of this account may work on: none for a user.
      servers={serversFor(user).map((s) => ({ id: s.id, label: s.name, where: `${s.username}@${s.host}:${s.port}`, off: s.status !== "enabled" }))}
      // The same for the site accounts its agents may sign in with.
      siteAccounts={accountsFor(user).map((a) => ({ id: a.id, label: a.name, where: `${a.username} on ${siteHost(a.siteUrl)}`, site: siteHost(a.siteUrl), off: a.status !== "enabled" }))}
      />
    </>
  );
}
