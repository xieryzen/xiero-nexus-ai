import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { projects, type Project, type User } from "@/db/schema";
import { Errors } from "./errors";
import { isAdminRole } from "@/lib/roles";
import { assertMayOperate } from "./ssh/servers";

/** Load a project the user is allowed to see (owner or admin), or throw. */
export function loadOwnedProject(id: string, user: User): Project {
  const p = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!p) throw Errors.notFound("Project not found");
  if (p.createdBy !== user.id && !isAdminRole(user.role)) throw Errors.forbidden();
  return p;
}

/**
 * Load a project to run it, change it or schedule it. Whoever does that tells
 * its agents what to do; where the project names servers, that is anything
 * on them. So besides being allowed to see the project, the account has to
 * be one whose own projects may work on every server it names.
 */
export function loadOperableProject(id: string, user: User): Project {
  const p = loadOwnedProject(id, user);
  assertMayOperate(p, user);
  return p;
}
