import { eq } from "drizzle-orm";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { handle, json } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { Errors } from "@/lib/errors";
import { getClientMeta } from "@/lib/request";
import { serializeProject } from "@/lib/workforce";

export const dynamic = "force-dynamic";

/** Admin approves a project that requires approval, clearing it to run once. */
export const POST = handle(async (req, { params }) => {
  const admin = requireAdmin();
  const { ip, userAgent } = getClientMeta(req);
  const project = db.select().from(projects).where(eq(projects.id, params.id!)).get();
  if (!project) throw Errors.notFound("Project not found");
  if (!project.requiresApproval) throw Errors.badRequest("This project does not require approval");

  db.update(projects)
    .set({ approved: true, status: "draft", updatedAt: new Date() })
    .where(eq(projects.id, project.id))
    .run();

  audit({ actorUserId: admin.id, action: "project.approve", targetType: "project", targetId: project.id, ip, userAgent });
  const fresh = db.select().from(projects).where(eq(projects.id, project.id)).get()!;
  return json({ project: serializeProject(fresh) });
});
