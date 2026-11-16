import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { projects, type Project, type User } from "@/db/schema";
import { Errors } from "./errors";
import { isAdminRole } from "@/lib/roles";

/** Load a project the user is allowed to see (owner or admin), or throw. */
export function loadOwnedProject(id: string, user: User): Project {
  const p = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!p) throw Errors.notFound("Project not found");
  if (p.createdBy !== user.id && !isAdminRole(user.role)) throw Errors.forbidden();
  return p;
}
