import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { projects, teams, workflows } from "@/db/schema";
import { requirePageUser } from "@/lib/auth";
import { ffmpegStatus } from "@/lib/media/ffmpeg";
import { projectFor } from "@/lib/for-viewer";
import { kindsAvailable } from "@/lib/model-choice";
import { chatModels, mediaModelOptions, usableModels } from "@/lib/model-options";
import { countMediaTasks } from "@/lib/orchestrator/plan";
import { serializeProject, serializeWorkflow } from "@/lib/workforce";
import { CommandCenter } from "@/components/projects/command-center";
import { isAdminRole, seesSetup } from "@/lib/roles";

export const dynamic = "force-dynamic";
export const metadata = { title: "AI Manager" };

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
  const can = chooses ? null : kindsAvailable();
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
    <CommandCenter
      initialProjects={projectRows.map((p) => projectFor(user.role, serializeProject(p)))}
      chooses={chooses}
      managerModels={managerModels}
      imageModels={imageModels}
      videoModels={videoModels}
      speechModels={speechModels}
      canRender={ffmpeg.available && ffmpeg.h264}
      teams={teamRows.map((t) => ({ id: t.id, label: t.name }))}
      workflows={workflowOptions}
    />
  );
}
