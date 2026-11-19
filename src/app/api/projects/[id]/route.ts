import { eq } from "drizzle-orm";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { handle, json, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getClientMeta } from "@/lib/request";
import { loadOperableProject, loadOwnedProject } from "@/lib/project-access";
import { checkedAccountIds, setProjectAccounts } from "@/lib/browser/accounts";
import { checkedServerIds, setProjectServers } from "@/lib/ssh/servers";
import { users } from "@/db/schema";
import { projectUpdateSchema } from "@/lib/validation";
import { serializeProject } from "@/lib/workforce";
import { projectFor } from "@/lib/for-viewer";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req, { params }) => {
  const user = requireUser();
  const p = loadOwnedProject(params.id!, user);
  return json({ project: projectFor(user.role, serializeProject(p, { withTasks: true })) });
});

/** Change a project's title, its goal, whether it remembers earlier runs, the servers it works on, or the site accounts it signs in with. */
export const PATCH = handle(async (req, { params }) => {
  const user = requireUser();
  const { ip, userAgent } = getClientMeta(req);
  const p = loadOperableProject(params.id!, user);
  const body = await parseBody(req, projectUpdateSchema);
  if (body.serverIds !== undefined) {
    // Servers this account may use, and that the account the project belongs
    // to may use as well: its runs work for that account.
    const ids = checkedServerIds(user, body.serverIds);
    const owner = p.createdBy ? db.select({ role: users.role }).from(users).where(eq(users.id, p.createdBy)).get() : undefined;
    checkedServerIds({ role: owner?.role ?? "user" }, ids);
    setProjectServers(p.id, ids);
  }
  if (body.siteAccountIds !== undefined) {
    // The same for the site accounts its agents sign in with.
    const ids = checkedAccountIds(user, body.siteAccountIds);
    const owner = p.createdBy ? db.select({ role: users.role }).from(users).where(eq(users.id, p.createdBy)).get() : undefined;
    checkedAccountIds({ role: owner?.role ?? "user" }, ids);
    setProjectAccounts(p.id, ids);
  }
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
  return json({ project: projectFor(user.role, serializeProject(updated, { withTasks: true })) });
});

export const DELETE = handle(async (req, { params }) => {
  const user = requireUser();
  const { ip, userAgent } = getClientMeta(req);
  const p = loadOwnedProject(params.id!, user);
  db.delete(projects).where(eq(projects.id, p.id)).run();
  audit({ actorUserId: user.id, action: "project.delete", targetType: "project", targetId: p.id, ip, userAgent });
  return json({ ok: true });
});
