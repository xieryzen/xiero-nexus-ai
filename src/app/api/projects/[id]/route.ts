import { eq } from "drizzle-orm";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { handle, json } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getClientMeta } from "@/lib/request";
import { loadOwnedProject } from "@/lib/project-access";
import { serializeProject } from "@/lib/workforce";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req, { params }) => {
  const user = requireUser();
  const p = loadOwnedProject(params.id!, user);
  return json({ project: serializeProject(p, { withTasks: true }) });
});

export const DELETE = handle(async (req, { params }) => {
  const user = requireUser();
  const { ip, userAgent } = getClientMeta(req);
  const p = loadOwnedProject(params.id!, user);
  db.delete(projects).where(eq(projects.id, p.id)).run();
  audit({ actorUserId: user.id, action: "project.delete", targetType: "project", targetId: p.id, ip, userAgent });
  return json({ ok: true });
});
