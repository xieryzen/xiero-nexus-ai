import { eq } from "drizzle-orm";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { handle, json, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getClientMeta } from "@/lib/request";
import { loadOwnedProject } from "@/lib/project-access";
import { projectUpdateSchema } from "@/lib/validation";
import { serializeProject } from "@/lib/workforce";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req, { params }) => {
  const user = requireUser();
  const p = loadOwnedProject(params.id!, user);
  return json({ project: serializeProject(p, { withTasks: true }) });
});

/** Change a project's title, its goal, or whether it remembers earlier runs. */
export const PATCH = handle(async (req, { params }) => {
  const user = requireUser();
  const { ip, userAgent } = getClientMeta(req);
  const p = loadOwnedProject(params.id!, user);
  const body = await parseBody(req, projectUpdateSchema);
  const updated = db
    .update(projects)
    .set({
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.goal !== undefined ? { goal: body.goal } : {}),
      ...(body.memory !== undefined ? { memory: body.memory } : {}),
      updatedAt: new Date(),
    })
    .where(eq(projects.id, p.id))
    .returning()
    .get();
  audit({
    actorUserId: user.id,
    action: "project.update",
    targetType: "project",
    targetId: p.id,
    metadata: { fields: Object.keys(body) },
    ip,
    userAgent,
  });
  return json({ project: serializeProject(updated, { withTasks: true }) });
});

export const DELETE = handle(async (req, { params }) => {
  const user = requireUser();
  const { ip, userAgent } = getClientMeta(req);
  const p = loadOwnedProject(params.id!, user);
  db.delete(projects).where(eq(projects.id, p.id)).run();
  audit({ actorUserId: user.id, action: "project.delete", targetType: "project", targetId: p.id, ip, userAgent });
  return json({ ok: true });
});
