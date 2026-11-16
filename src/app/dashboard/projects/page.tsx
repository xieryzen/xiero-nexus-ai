import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { projects, teams, workflows } from "@/db/schema";
import { requirePageUser } from "@/lib/auth";
import { ffmpegStatus } from "@/lib/media/ffmpeg";
import { chatModels, mediaModelOptions, usableModels } from "@/lib/model-options";
import { countMediaTasks } from "@/lib/orchestrator/plan";
import { serializeProject, serializeWorkflow } from "@/lib/workforce";
import { CommandCenter } from "@/components/projects/command-center";
import { isAdminRole } from "@/lib/roles";

export const dynamic = "force-dynamic";
export const metadata = { title: "AI Manager" };

export default async function ProjectsPage() {
  const user = requirePageUser();

  const projectRows =
    isAdminRole(user.role)
      ? db.select().from(projects).orderBy(desc(projects.updatedAt)).all()
      : db.select().from(projects).where(eq(projects.createdBy, user.id)).orderBy(desc(projects.updatedAt)).all();

  const allModels = usableModels();
  const managerModels = chatModels(allModels).map((m) => ({
    id: m.id,
    label: `${m.name} · ${m.providerName}`,
  }));
  const imageModels = mediaModelOptions("image", allModels).map((m) => ({ id: m.id, label: m.label }));
  const videoModels = mediaModelOptions("video", allModels).map((m) => ({ id: m.id, label: m.label }));
  const speechModels = mediaModelOptions("audio", allModels).map((m) => ({ id: m.id, label: m.label }));
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
      initialProjects={projectRows.map((p) => serializeProject(p))}
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
