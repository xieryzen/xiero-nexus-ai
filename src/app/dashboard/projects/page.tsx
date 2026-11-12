import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { projects, teams, workflows } from "@/db/schema";
import { requirePageUser } from "@/lib/auth";
import { chatModels, mediaModelOptions, usableModels } from "@/lib/model-options";
import { countMediaTasks } from "@/lib/orchestrator/plan";
import { serializeProject, serializeWorkflow } from "@/lib/workforce";
import { CommandCenter } from "@/components/projects/command-center";

export const dynamic = "force-dynamic";
export const metadata = { title: "AI Manager" };

export default function ProjectsPage() {
  const user = requirePageUser();

  const projectRows =
    user.role === "admin"
      ? db.select().from(projects).orderBy(desc(projects.updatedAt)).all()
      : db.select().from(projects).where(eq(projects.createdBy, user.id)).orderBy(desc(projects.updatedAt)).all();

  const allModels = usableModels();
  const managerModels = chatModels(allModels).map((m) => ({
    id: m.id,
    label: `${m.name} · ${m.providerName}`,
  }));
  const imageModels = mediaModelOptions("image", allModels).map((m) => ({ id: m.id, label: m.label }));
  const videoModels = mediaModelOptions("video", allModels).map((m) => ({ id: m.id, label: m.label }));

  const teamRows = db.select({ id: teams.id, name: teams.name }).from(teams).orderBy(asc(teams.name)).all();
  // How many images / videos each workflow generates, so the form can ask for
  // the models it needs before the project is created.
  const workflowOptions = db
    .select()
    .from(workflows)
    .orderBy(asc(workflows.name))
    .all()
    .map((w) => ({
      id: w.id,
      label: w.name,
      media: countMediaTasks(serializeWorkflow(w).steps.map((step) => ({ kind: step.kind ?? "text" }))),
    }));

  return (
    <CommandCenter
      initialProjects={projectRows.map((p) => serializeProject(p))}
      managerModels={managerModels}
      imageModels={imageModels}
      videoModels={videoModels}
      teams={teamRows.map((t) => ({ id: t.id, label: t.name }))}
      workflows={workflowOptions}
    />
  );
}
