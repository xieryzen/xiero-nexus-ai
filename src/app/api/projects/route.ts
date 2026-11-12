import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { models, projects, teams, workflows } from "@/db/schema";
import { handle, json, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { DEFAULT_MAX_MEDIA } from "@/lib/creative/prompt";
import { AppError, Errors } from "@/lib/errors";
import { modelIsMediaOnly } from "@/lib/gateway";
import { resolveMediaModel } from "@/lib/media/service";
import { countMediaTasks } from "@/lib/orchestrator/plan";
import { getClientMeta } from "@/lib/request";
import { serializeProject, serializeWorkflow } from "@/lib/workforce";
import { projectCreateSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const user = requireUser();
  const rows =
    user.role === "admin"
      ? db.select().from(projects).orderBy(desc(projects.updatedAt)).all()
      : db.select().from(projects).where(eq(projects.createdBy, user.id)).orderBy(desc(projects.updatedAt)).all();
  return json({ projects: rows.map((p) => serializeProject(p)) });
});

export const POST = handle(async (req) => {
  const user = requireUser();
  const { ip, userAgent } = getClientMeta(req);
  const body = await parseBody(req, projectCreateSchema);

  const model = db.select({ id: models.id }).from(models).where(eq(models.id, body.managerModelRowId)).get();
  if (!model) throw Errors.badRequest("Selected manager model does not exist");
  if (modelIsMediaOnly(model.id)) {
    throw Errors.badRequest("The manager model must be a chat model, not an image or video model.");
  }
  if (body.teamId) {
    const team = db.select({ id: teams.id }).from(teams).where(eq(teams.id, body.teamId)).get();
    if (!team) throw Errors.badRequest("Selected team does not exist");
  }

  // Creative workflows: the models must be usable for that kind of media.
  for (const [kind, id] of [
    ["image", body.imageModelRowId],
    ["video", body.videoModelRowId],
  ] as const) {
    if (!id) continue;
    try {
      resolveMediaModel(id, kind);
    } catch (err) {
      throw Errors.badRequest(
        `${kind === "image" ? "Image" : "Video"} model: ${err instanceof AppError ? err.message : "not usable"}`,
      );
    }
  }
  const maxMedia = body.maxMedia ?? DEFAULT_MAX_MEDIA;
  if (body.workflowId) {
    const wf = db.select().from(workflows).where(eq(workflows.id, body.workflowId)).get();
    if (!wf) throw Errors.badRequest("Selected workflow does not exist");
    // A workflow's steps are fixed, so what it needs is known before it runs.
    const need = countMediaTasks(
      serializeWorkflow(wf).steps.map((step) => ({ kind: step.kind ?? "text" })),
    );
    if (need.image > 0 && !body.imageModelRowId) {
      throw Errors.badRequest(`The workflow "${wf.name}" has image steps. Choose an image model.`);
    }
    if (need.video > 0 && !body.videoModelRowId) {
      throw Errors.badRequest(`The workflow "${wf.name}" has video steps. Choose a video model.`);
    }
    if (need.image + need.video > maxMedia) {
      throw Errors.badRequest(
        `The workflow "${wf.name}" generates ${need.image + need.video} images and videos, more than this project's media limit of ${maxMedia}.`,
      );
    }
  }

  const project = db
    .insert(projects)
    .values({
      title: body.title,
      goal: body.goal,
      managerModelRowId: body.managerModelRowId,
      teamId: body.teamId ?? null,
      maxTokens: body.maxTokens ?? 200_000,
      maxTasks: body.maxTasks ?? 12,
      maxParallel: body.maxParallel ?? 3,
      requiresApproval: body.requiresApproval ?? false,
      hardQaGate: body.hardQaGate ?? false,
      workflowId: body.workflowId ?? null,
      imageModelRowId: body.imageModelRowId ?? null,
      videoModelRowId: body.videoModelRowId ?? null,
      maxMedia,
      createdBy: user.id,
    })
    .returning()
    .get();

  audit({ actorUserId: user.id, action: "project.create", targetType: "project", targetId: project.id, metadata: { title: project.title }, ip, userAgent });
  return json({ project: serializeProject(project, { withTasks: true }) }, { status: 201 });
});
