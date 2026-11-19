import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { models, projects, teams, workflows } from "@/db/schema";
import { handle, json, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { DEFAULT_MAX_MEDIA } from "@/lib/creative/prompt";
import { AppError, Errors, PlainError } from "@/lib/errors";
import { modelIsMediaOnly } from "@/lib/gateway";
import { resolveMediaModel } from "@/lib/media/service";
import { countMediaTasks } from "@/lib/orchestrator/plan";
import { getClientMeta } from "@/lib/request";
import { serializeProject, serializeWorkflow } from "@/lib/workforce";
import { projectCreateSchema } from "@/lib/validation";
import { isAdminRole, seesSetup } from "@/lib/roles";
import { projectFor } from "@/lib/for-viewer";
import { appChoice } from "@/lib/model-choice";
import { checkedServerIds, setProjectServers } from "@/lib/ssh/servers";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const user = requireUser();
  const rows =
    isAdminRole(user.role)
      ? db.select().from(projects).orderBy(desc(projects.updatedAt)).all()
      : db.select().from(projects).where(eq(projects.createdBy, user.id)).orderBy(desc(projects.updatedAt)).all();
  return json({ projects: rows.map((p) => projectFor(user.role, serializeProject(p))) });
});

export const POST = handle(async (req) => {
  const user = requireUser();
  const { ip, userAgent } = getClientMeta(req);
  const body = await parseBody(req, projectCreateSchema);

  // An administrator chooses the project's models. A user chooses none: the
  // app works with its own choice at every run, and a user only says which
  // kinds of media the project may make (any value in the model's place).
  const chooses = seesSetup(user.role);
  const WHAT = { image: "images", video: "videos", audio: "voice-overs" } as const;
  const wanted = {
    image: Boolean(body.imageModelRowId),
    video: Boolean(body.videoModelRowId),
    audio: Boolean(body.speechModelRowId),
  };
  if (!chooses) {
    body.managerModelRowId = null;
    for (const kind of ["image", "video", "audio"] as const) {
      const key = kind === "image" ? "imageModelRowId" : kind === "video" ? "videoModelRowId" : "speechModelRowId";
      if (!wanted[kind]) {
        body[key] = null;
        continue;
      }
      body[key] = appChoice(kind);
      if (!body[key]) {
        throw new PlainError(400, "bad_request", `This installation cannot make ${WHAT[kind]} yet. An administrator has to set it up.`);
      }
    }
  } else {
    if (!body.managerModelRowId) throw Errors.badRequest("Choose a manager model");
    const model = db.select({ id: models.id }).from(models).where(eq(models.id, body.managerModelRowId)).get();
    if (!model) throw Errors.badRequest("Selected manager model does not exist");
    if (modelIsMediaOnly(model.id)) {
      throw Errors.badRequest("The manager model must be a chat model, not a media or embedding model.");
    }
  }
  if (body.teamId) {
    const team = db.select({ id: teams.id }).from(teams).where(eq(teams.id, body.teamId)).get();
    if (!team) throw Errors.badRequest("Selected team does not exist");
  }

  // Creative workflows: the models must be usable for that kind of media.
  const LABEL = { image: "Image", video: "Video", audio: "Speech" } as const;
  for (const [kind, id] of [
    ["image", body.imageModelRowId],
    ["video", body.videoModelRowId],
    ["audio", body.speechModelRowId],
  ] as const) {
    if (!id || !chooses) continue;
    try {
      resolveMediaModel(id, kind);
    } catch (err) {
      throw Errors.badRequest(
        `${LABEL[kind]} model: ${err instanceof AppError ? err.message : "not usable"}`,
      );
    }
  }
  const maxMedia = body.maxMedia ?? DEFAULT_MAX_MEDIA;
  const maxTasks = body.maxTasks ?? 12;
  if (body.workflowId) {
    const wf = db.select().from(workflows).where(eq(workflows.id, body.workflowId)).get();
    if (!wf) throw Errors.badRequest("Selected workflow does not exist");
    // A workflow's steps are fixed, so what it needs is known before it runs.
    const steps = serializeWorkflow(wf).steps;
    const need = countMediaTasks(steps.map((step) => ({ kind: step.kind ?? "text" })));
    if (!chooses) {
      // What the workflow makes, the project may make.
      for (const kind of ["image", "video", "audio"] as const) {
        if (need[kind] === 0) continue;
        const key = kind === "image" ? "imageModelRowId" : kind === "video" ? "videoModelRowId" : "speechModelRowId";
        body[key] = body[key] ?? appChoice(kind);
        if (!body[key]) {
          throw new PlainError(
            400,
            "bad_request",
            `The workflow "${wf.name}" makes ${WHAT[kind]}, which this installation cannot do yet. An administrator has to set it up.`,
          );
        }
      }
    }
    if (need.image > 0 && !body.imageModelRowId) {
      throw Errors.badRequest(`The workflow "${wf.name}" has image steps. Choose an image model.`);
    }
    if (need.video > 0 && !body.videoModelRowId) {
      throw Errors.badRequest(`The workflow "${wf.name}" has video steps. Choose a video model.`);
    }
    if (need.audio > 0 && !body.speechModelRowId) {
      throw Errors.badRequest(`The workflow "${wf.name}" has voice-over steps. Choose a speech model.`);
    }
    const generated = need.image + need.video + need.audio;
    if (generated > maxMedia) {
      throw Errors.badRequest(
        `The workflow "${wf.name}" generates ${generated} images, videos and voice-overs, more than this project's media limit of ${maxMedia}.`,
      );
    }
    if (steps.length > maxTasks) {
      throw Errors.badRequest(
        `The workflow "${wf.name}" has ${steps.length} steps, more than this project's task limit of ${maxTasks}.`,
      );
    }
  }

  // The machines its agents may work on: ones the projects of this account may use.
  const serverIds = checkedServerIds(user, body.serverIds);

  const project = db
    .insert(projects)
    .values({
      title: body.title,
      goal: body.goal,
      managerModelRowId: body.managerModelRowId ?? null,
      teamId: body.teamId ?? null,
      maxTokens: body.maxTokens ?? 200_000,
      maxTasks,
      maxParallel: body.maxParallel ?? 3,
      requiresApproval: body.requiresApproval ?? false,
      hardQaGate: body.hardQaGate ?? false,
      workflowId: body.workflowId ?? null,
      imageModelRowId: body.imageModelRowId ?? null,
      videoModelRowId: body.videoModelRowId ?? null,
      speechModelRowId: body.speechModelRowId ?? null,
      maxMedia,
      memory: body.memory ?? false,
      createdBy: user.id,
    })
    .returning()
    .get();

  if (serverIds.length > 0) setProjectServers(project.id, serverIds);

  audit({
    actorUserId: user.id,
    action: "project.create",
    targetType: "project",
    targetId: project.id,
    metadata: { title: project.title, ...(serverIds.length > 0 ? { servers: serverIds.length } : {}) },
    ip,
    userAgent,
  });
  return json({ project: projectFor(user.role, serializeProject(project, { withTasks: true })) }, { status: 201 });
});
