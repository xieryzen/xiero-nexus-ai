import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { models, projects, teams } from "@/db/schema";
import { handle, json, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { Errors } from "@/lib/errors";
import { getClientMeta } from "@/lib/request";
import { serializeProject } from "@/lib/workforce";
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
  if (body.teamId) {
    const team = db.select({ id: teams.id }).from(teams).where(eq(teams.id, body.teamId)).get();
    if (!team) throw Errors.badRequest("Selected team does not exist");
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
      createdBy: user.id,
    })
    .returning()
    .get();

  audit({ actorUserId: user.id, action: "project.create", targetType: "project", targetId: project.id, metadata: { title: project.title }, ip, userAgent });
  return json({ project: serializeProject(project, { withTasks: true }) }, { status: 201 });
});
